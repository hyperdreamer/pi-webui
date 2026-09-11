# Design Document: Workspace Tasks Panel Responsiveness While Sessions Run

## 1. Background & Problem Statement

While a project session is running, the Workspace → Tasks panel (`pi-webui-plugins/workspace-tasks`)
responds slowly: collapse/expand of task groups, `Run`, and `Add Task` feel delayed and sticky.

### Root Cause

1. A running session publishes `status.update` and `activity.update` continuously. A live
   8-second sample on the production app (`:8808`) measured **415 events / 51.9 msg/s**
   (241 `activity.update`, 174 `status.update`).
2. `SessionController` buffers those events and flushes them from a `requestAnimationFrame`
   callback, so the host component (`PiWebUiApp`) renders at up to one render per animation
   frame while a session streams.
3. On every host render, `resolvedWorkspacePanelTabs()` builds a new plugin context and the
   Lit template re-commits all three object properties of `pi-webui-workspace-tasks-panel`.
   lit-html commits non-primitive property bindings unconditionally
   (`AttributePart._$setValue`: `change = !isPrimitive(value) || ...`), so identity guards
   cannot live in the host template.
4. Each of the panel's three property setters calls `render()` unconditionally, and
   `render()` assigns `this.root.innerHTML = taskStyles() + <full panel template>` and
   re-binds every listener.

Measured with a raw-CDP instrumentation run (per-setter and per-render counters, 4x CPU
throttle, 51 host renders over 4 s) recorded in the run's diagnosis report; the archived
probe script reproduces the panel/app render counts and click latencies:

```
appRender: 51, contextSets: 51 (51 distinct objects),
stateSets: 51 (1 distinct object),
actionSets: 51 (1 distinct object),
renderCalls: 153, publishes: 0
```

i.e. **3 full shadow-DOM rewrites per host render with no tasks-state change**, ~7.3 ms each
under 4x throttle. Real clicks on group summaries measured 68–143 ms latency when idle and
125–322 ms under render load, and each rewrite replaces the `<details>`/button nodes
mid-gesture.

### Prior Art

- `workspace-memory` and `workspace-learned-skills` — the other two non-Lit, innerHTML
  plugin panels — already early-return on identical state and treat repeated context
  assignment as a no-op.
- Core workspace panels (Files, Git, Terminal, Info, Recent Projects) are Lit elements and
  diff internally.

## 2. Goals & Non-Goals

**Goals**

- The Tasks panel performs no shadow-DOM rewrite when a host re-render delivers no change it
  renders: same context key, same tasks state object, same actions object.
- The newest context value is still stored so `Run`/`Open Terminal` use the latest terminal
  facade after a skipped re-render.
- All existing behavior is preserved: mount renders, controller state changes render,
  context key changes reset panel mode/editor/filter as today.
- Regression tests pin the idempotency contract; a patch Changeset records the user-visible
  fix.

**Non-Goals**

- Reducing app-wide render amplification while sessions stream (e.g. non-selected session
  status/activity updates triggering full-app renders).
- Preserving panel scroll position across legitimate (state-driven) re-renders.
- Changing the other bundled panels or the host `WorkspacePanel`/`PiWebUiApp` render path.
- Any session-daemon or server-side behavior.

## 3. Architecture & Detailed Changes

Single file: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.

### A. `set context(value: WorkspacePanelContext | undefined)`

Current behavior renders on every assignment, and only resets panel state when `contextKey`
changes. New behavior:

```ts
set context(value: WorkspacePanelContext | undefined) {
  const previousKey = contextKey(this.contextValue);
  const nextKey = contextKey(value);
  this.contextValue = value;                 // newest terminal facade stays usable
  if (previousKey === nextKey && nextKey !== undefined) return; // host re-render
  // unchanged reset of selectionGeneration, operations, editor, filter, mode, ...
  this.render();
}
```

The `nextKey !== undefined` condition preserves the visible behavior for the
`undefined -> undefined` case: a detached or empty panel still renders the "Select a
workspace" placeholder, as today. (The reset block runs in that branch too, but no
editor, operation, or pending action can exist while `contextValue` is undefined, so the
only observable outcome is the placeholder render.) A defined unchanged key skips.

The panel's rendered output does not depend on any other context field; the only context
member read after mount is `contextValue.terminal` at dispatch/open time. `contextKey`
already covers machine id, project id, workspace id, and workspace path.

### B. `set workspaceTasksState(value: WorkspaceTasksPanelState)`

Add an identity early-return before observations/reconciliation/render:

```ts
set workspaceTasksState(value: WorkspaceTasksPanelState) {
  if (value === this.stateValue) return;
  const previous = this.stateValue;
  this.stateValue = value;
  // unchanged observation, move-recovery, reconcile, render logic
}
```

The controller publishes a new immutable state object whenever anything the panel renders
changes, so reference equality is the correct "changed" signal.

### C. `set workspaceTasksActions(value: WorkspaceTasksPanelActions)`

```ts
set workspaceTasksActions(value: WorkspaceTasksPanelActions) {
  if (value === this.actionsValue) return;
  this.actionsValue = value;
  this.render();
}
```

The controller assigns a stable frozen actions object once, so this guard only fires on a
genuine controller replacement.

### D. Interaction Notes

- Group collapse/expand already only mutates `expandedGroupKeys` from the `toggle` listener;
  it does not re-render, and `rememberOpenGroups`/`pruneExpandedGroups` keep that state across
  legitimate renders.
- Filters, editor modes, delete/move confirmations, and refresh keep calling `render()`
  directly and are unaffected.

## 4. Error Handling & Edge Cases

- First mount: each setter sees a different value (or `undefined`), so the panel still
  renders and behaves exactly as before.
- Context key change (`machine`, `projectId`, `workspaceId`, or `path`): existing reset path
  runs unchanged, discarding editor/delete/move state, filter, and status.
- Same key, new context object (host re-render): property stored, no render, no state reset.
- Tasks state refresh/mutation/move/gate: new object from `publishCurrent` → render.
- `Run` after a skipped re-render: must use the newest `contextValue.terminal`; covered by a
  test so a future refactor cannot silently drop the assignment.
- A panel that has never received a context (`undefined` → `undefined`) keeps rendering the
  "Select a workspace" placeholder, exactly as today; only a defined, unchanged key skips.
  `connectedCallback` still renders once on mount.

## 5. Test Strategy

Layer: component-boundary tests in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`
(jsdom, direct element assignment — the existing harness in that file).

1. **Identical inputs do not rewrite the shadow DOM.** Mount with a loaded state; for the
   strongest signal open the Add Task editor and capture its input node (otherwise capture
   e.g. the refresh button). Assign a new context object with the same key, the same state,
   and the same actions; assert the captured node is still the current node in the shadow
   root and the editor is still open.
2. **Identity, not deep equality, is the change signal.** Assign a structurally identical
   *clone* of the current state (same catalogs, new object) and assert the shadow DOM was
   rewritten (captured node identity changes). This pins the reference-equality contract so an
   accidental deep-equal implementation fails. It also protects pending-action reconciliation,
   which depends on observing every delivered state object even when only
   `sourceGenerations` changed.
3. **A state object with different content still updates the DOM.** Assign a state with
   different tasks; assert the rendered task rows change.
4. **A different context key still resets the panel.** Open the Add Task editor, assign a
   context with a different workspace id/path, assert the editor is gone and the view mode
   renders.
5. **The newest context facade survives a skipped render.** Assign a second context with the
   same key but fresh `terminal.runCommand` and `terminal.open` spies; click `Run` and assert
   `runCommand` was called, then re-query `[data-open-terminal]` (the Run click re-renders the
   panel), click it, and assert `open` was called.
6. **Expansion persists across a state-driven render with new identity.** Toggle a group
   open, assign a structurally identical state object, and assert the group is still open.
   The existing "preserves expansion by scoped group key" test re-assigns the *same* state
   object, which becomes a no-op under the guard; that assertion must be updated to deliver a
   fresh object (or replaced by this test) so expansion persistence across renders stays
   covered.
7. **Actions guard.** Re-assigning the same actions object leaves the DOM untouched; a new
   actions object triggers a render (can be folded into test 1/2 or asserted separately).

## 6. Verification

1. Focused tests: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`.
2. CDP probe re-run against a build containing the fix with the same workload: expect
   **0 panel renders** while host re-renders deliver unchanged inputs (was 3 per host
   render). Click latency is recorded as a before/after measurement, not an equality
   expectation, because the app-wide host render path is unchanged and out of scope. The
   probe script and its JSON results are archived PM evidence under the run's
   `reports/probe/` directory
   (`/home/henry/.local/state/pi/project-manager/runs/4074842dc9aaf003446194e3e1d1201d34aca2f4bd236012ec3be919dd6e7164/pm-run-20260911-114113-f9cf2acd/reports/probe/tasks-responsiveness-probe.mjs`,
   run from `/data/home/guest/Development/pi-webui` with `node <script> --port 9333 --url
   "http://127.0.0.1:8808/?machine=local&project=<id>&workspace=<id>&tool=workspace-tasks%3Aworkspace.tasks"
   --out <result.json>`); the setter-level counters in section 1 come from the diagnosis
   report's instrumentation run (`reports/diagnosis-workspace-tasks-responsiveness.md`).
   The repository intentionally keeps no one-off probe script.
3. `npm run verify` (typecheck, lint, knip, serial test suite).
4. Patch Changeset: "Keep the Workspace Tasks panel responsive while sessions stream."

## 7. Operational & Deployment Notes

- The change lives in a bundled plugin asset, not in `src/server/sessiond.ts`. Per
  `AGENTS.md`, no session-daemon restart is required; the web/UI side reload (plugin rebuild +
  browser reload) is sufficient.
- Delivery target is `main`; the integration branch stays under PM control until the delivery
  decision.

## 8. Out of Scope / Follow-Ups

- Option B (app-wide render amplification for running sessions) was explicitly deferred.
- If other non-Lit panels are added later, they should adopt the same identity-guard
  contract; the sibling panels already do.
