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

Measured with a raw-CDP probe against the live released app (4x CPU throttle, 51 host
renders over 4 s):

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
  this.contextValue = value;           // newest terminal facade stays usable
  if (previousKey === nextKey) return; // host re-render: nothing this panel renders changed
  // unchanged reset of selectionGeneration, operations, editor, filter, mode, ...
  this.render();
}
```

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
- A panel that has never received a context (`undefined` → `undefined`) skips rendering
  rather than rendering the "Select a workspace" placeholder; `connectedCallback` still
  renders once on mount.

## 5. Test Strategy

Layer: component-boundary tests in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`
(jsdom, direct element assignment — the existing harness in that file).

1. **Identical inputs do not rewrite the shadow DOM.** Mount with a loaded state; capture a
   node reference (e.g. the refresh button). Assign a new context object with the same key,
   the same state, and the same actions; assert the captured node is still the current node in
   the shadow root.
2. **A new state object still updates the DOM.** Assign a state with different tasks; assert
   the rendered task rows change.
3. **A different context key still resets the panel.** Open the Add Task editor, assign a
   context with a different workspace id/path, assert the editor is gone and the view mode
   renders.
4. **The newest context facade survives a skipped render.** Assign a second context with the
   same key but a fresh `runCommand` spy; click `Run`; assert the new spy is called.
5. **Actions guard.** Re-assigning the same actions object leaves the DOM untouched; a new
   actions object triggers a render (can be folded into test 1/2 or asserted separately).

Existing tests (including "preserves expansion by scoped group key", which re-assigns the
same state object) must keep passing.

## 6. Verification

1. Focused tests: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`.
2. CDP probe re-run against a build containing the fix with the same workload: expect
   **0 panel renders** while host re-renders deliver unchanged inputs (was 3 per host
   render), and click latency back at the idle baseline.
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
