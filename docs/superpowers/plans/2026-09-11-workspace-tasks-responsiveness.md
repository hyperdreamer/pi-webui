# Workspace Tasks Panel Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Lane:** workspace-tasks-panel-guards
**Category:** Bug fix — workspace tasks panel responsiveness

**Goal:** Make `pi-webui-workspace-tasks-panel` skip its shadow-DOM rewrite when a host re-render re-assigns an unchanged context, state, or actions value while a session streams.

**Architecture:** Add reference-equality early returns to the three non-primitive property setters of `PiWebUiTasksPanel` in the single production file `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`, keeping the unconditional context storage and every reset, observation, move-recovery, and reconciliation path intact. Task 1 delivers the RED regression tests plus the required update to the existing expansion test; Task 2 applies the guards and records a patch Changeset.

**Tech Stack:** TypeScript, custom element with `innerHTML` shadow-DOM rendering, Vitest with jsdom, Changesets.

## Global Constraints

- The only production file that may change is `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- The change signal is reference equality (`===`) only; do not introduce deep equality, rendered-content comparison, or memoized snapshots.
- Do not change `WorkspacePanel`, `PiWebUiApp`, the plugin render template, `resolvedWorkspacePanelTabs()`, or any host/app-wide render path.
- Do not change `src/server/sessiond.ts`, any server, API, or protocol file. No session-daemon restart is required; do not restart `pi-webui-sessiond.service`.
- Create `.changeset/workspace-tasks-panel-responsiveness.md` with exactly this content:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Keep the Workspace Tasks panel responsive while sessions stream.
```

- Every task's requirements implicitly include this section.

## Task 1: Pin the identity-guard render contract with RED regression tests

**Implementer tier:** Standard

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts:19-24` (add two optional members to the local `WorkspaceTasksWorkspaceState` interface)
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts:50-55` (insert the `clonePanelState` helper between the `state` helper and `beforeEach`)
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts:121` (update the existing expansion test)
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts:152-158` (append six new tests inside the existing `describe("workspace tasks panel", ...)` block)

**Interfaces:**

- Consumes: `defineTasksPanelElement(): void` and `tasksPanelTagName = "pi-webui-workspace-tasks-panel"` from `./tasksPanelElement.js`.
- Consumes: the existing test harness in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`:
  `mount(nextState: WorkspaceTasksWorkspaceState, options?: { runCommand?: WorkspacePanelContext["terminal"]["runCommand"] }): TasksPanelElement`,
  `state(workspace: readonly WorkspaceTask[], global: readonly WorkspaceTask[]): WorkspaceTasksWorkspaceState`,
  `workspaceTask(overrides?: Partial<WorkspaceTask>): WorkspaceTask`,
  `button(panel: HTMLElement, selector: string): HTMLButtonElement`,
  `createContext(runCommand?: WorkspacePanelContext["terminal"]["runCommand"]): WorkspacePanelContext`,
  `terminalHandle(): TerminalCommandRunHandle`.
- Consumes: the test file's existing local type declarations:
  `TasksPanelElement extends HTMLElement = { context: WorkspacePanelContext | undefined; workspaceTasksState: WorkspaceTasksWorkspaceState; workspaceTasksActions: WorkspaceTasksActions }`,
  `CatalogState = { readonly kind: "loading" | "loaded" | "missing" | "invalid" | "unavailable" | "error"; readonly config?: { readonly version: 1; readonly tasks: readonly Readonly<WorkspaceTask>[] }; readonly message?: string; readonly hint?: string; readonly detail?: string; readonly refreshing?: boolean; readonly refreshError?: string }`,
  `WorkspaceTasksActions = { create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>; update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>; remove(ref: WorkspaceTaskRef): Promise<void>; move(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>; retryMove(): Promise<void>; refresh(): Promise<void> }`.
- Consumes: existing imports `WorkspacePanelContext`, `TerminalCommandRun`, `TerminalCommandRunHandle` from `@hyperdreamer/pi-webui/plugin-api`, and `WorkspaceTask`, `WorkspaceTaskRef`, `WorkspaceTaskScope` from `../../src/shared/workspaceTasks`.
- Consumes: the test file's existing vitest imports `describe`, `expect`, `it`, and `vi` from `vitest`.
- Produces: `clonePanelState(source: TasksPanelElement["workspaceTasksState"]): TasksPanelElement["workspaceTasksState"]` as a new file-local helper in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`.
- Produces: `WorkspaceTasksWorkspaceState` extended with `readonly sourceGenerations?: Readonly<Record<WorkspaceTaskScope, number>>` and `readonly moveError?: { readonly kind: "validation" | "unavailable"; readonly message: string }`.
- Produces: six new tests in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`, named exactly:
  `"does not rewrite the shadow DOM when context, state, and actions are re-assigned unchanged"`,
  `"treats a structurally identical state clone as a change and rewrites the shadow DOM"`,
  `"renders updated task content for a state object with different tasks"`,
  `"resets panel state when the context key changes"`,
  `"uses the newest context terminal facade after a skipped re-render"`,
  `"leaves the DOM untouched for identical actions and rewrites it for a new actions object"`.
- Produces: the existing test `"renders native collapsed details groups with counts and preserves expansion by scoped group key"` updated so its re-render assignment uses `clonePanelState`.

- [ ] **Step 1: Add the two optional members to the local state interface**

In `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`, replace the whole `WorkspaceTasksWorkspaceState` interface with exactly:

```ts
interface WorkspaceTasksWorkspaceState {
  readonly workspace: CatalogState;
  readonly global: CatalogState;
  readonly sourceGenerations?: Readonly<Record<WorkspaceTaskScope, number>>;
  readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean };
  readonly moveError?: { readonly kind: "validation" | "unavailable"; readonly message: string };
  readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string };
}
```

- [ ] **Step 2: Add the `clonePanelState` helper after the `state` helper**

Immediately after the `const state = (...) => ({ ... });` helper and before the `beforeEach(...)` call, insert exactly:

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

- [ ] **Step 3: Update the existing expansion test to re-assign a clone**

Inside the test `"renders native collapsed details groups with counts and preserves expansion by scoped group key"`, change exactly this line:

```ts
    panel.workspaceTasksState = initial;
```

to exactly:

```ts
    panel.workspaceTasksState = clonePanelState(initial);
```

Locate it by the quoted text, not by its line number: earlier inserts shift the line. Do not add a separate duplicate expansion test for the same scenario, and do not change any other line of that test.

- [ ] **Step 4: Append the six new tests inside the existing describe block**

Insert this block immediately after the existing test `"shows a scoped failure without hiding the usable source"` and before the `describe("workspace tasks panel", ...)` closing `});`, keeping the two-space `it` indentation of the surrounding tests:

```ts
  it("does not rewrite the shadow DOM when context, state, and actions are re-assigned unchanged", () => {
    const panel = mount(state([workspaceTask({ group: "Checks" })], []));
    button(panel, "[data-add-task]").click();
    const inputBefore = panel.shadowRoot?.querySelector("[data-editor-title]");
    const refreshBefore = button(panel, "[data-refresh]");
    const stateBefore = panel.workspaceTasksState;
    const actionsBefore = panel.workspaceTasksActions;

    panel.context = createContext();
    panel.workspaceTasksState = stateBefore;
    panel.workspaceTasksActions = actionsBefore;

    expect(inputBefore).not.toBeNull();
    expect(panel.shadowRoot?.querySelector("[data-editor-title]")).toBe(inputBefore);
    expect(button(panel, "[data-refresh]")).toBe(refreshBefore);
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();
  });

  it("treats a structurally identical state clone as a change and rewrites the shadow DOM", () => {
    const panel = mount(state([workspaceTask({ group: "Checks" })], []));
    const refreshBefore = button(panel, "[data-refresh]");

    panel.workspaceTasksState = clonePanelState(panel.workspaceTasksState);

    expect(button(panel, "[data-refresh]")).not.toBe(refreshBefore);
    expect(panel.shadowRoot?.textContent).toContain("Build");
  });

  it("renders updated task content for a state object with different tasks", () => {
    const panel = mount(state([workspaceTask({ id: "alpha", title: "Alpha" })], []));

    panel.workspaceTasksState = state([workspaceTask({ id: "beta", title: "Beta" })], []);

    expect(panel.shadowRoot?.textContent).toContain("Beta");
    expect(panel.shadowRoot?.textContent).not.toContain("Alpha");
  });

  it("resets panel state when the context key changes", () => {
    const panel = mount(state([workspaceTask()], []));
    button(panel, "[data-add-task]").click();
    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).not.toBeNull();

    const base = createContext();
    panel.context = { ...base, workspace: { ...base.workspace, id: "ws-2", path: "/tmp/ws-2" } };

    expect(panel.shadowRoot?.querySelector("[data-task-editor]")).toBeNull();
    expect(panel.shadowRoot?.querySelector("[data-panel-mode='view']")).not.toBeNull();
    expect(button(panel, "[data-filter='all']").getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the newest context terminal facade after a skipped re-render", () => {
    const firstRun = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => Promise.resolve(terminalHandle()));
    const panel = mount(state([workspaceTask()], []), { runCommand: firstRun });
    const secondRun = vi.fn<WorkspacePanelContext["terminal"]["runCommand"]>(() => Promise.resolve(terminalHandle()));
    const secondContext = createContext(secondRun);
    const secondOpen = vi.fn();
    panel.context = { ...secondContext, terminal: { ...secondContext.terminal, open: secondOpen } };

    button(panel, "[data-run-task='workspace:build']").click();
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(firstRun).not.toHaveBeenCalled();

    button(panel, "[data-open-terminal]").click();
    expect(secondOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves the DOM untouched for identical actions and rewrites it for a new actions object", () => {
    const panel = mount(state([workspaceTask()], []));
    const refreshBefore = button(panel, "[data-refresh]");
    const actionsBefore = panel.workspaceTasksActions;

    panel.workspaceTasksActions = actionsBefore;
    expect(button(panel, "[data-refresh]")).toBe(refreshBefore);

    panel.workspaceTasksActions = { ...actionsBefore };
    expect(button(panel, "[data-refresh]")).not.toBe(refreshBefore);
  });
```

- [ ] **Step 5: Run the focused test file and record the RED result**

Run: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`

Expected RED: `Test Files  1 failed (1)`, `Tests  2 failed | 9 passed (11)`.

- Test 1 fails at `expect(panel.shadowRoot?.querySelector("[data-editor-title]")).toBe(inputBefore)` because the current setters render unconditionally and replace the captured node.
- Test 6 fails at its first assertion `expect(button(panel, "[data-refresh]")).toBe(refreshBefore)` because the current actions setter renders on the same-object reassignment.
- Tests 2, 3, 4, and 5 pass against the current source. Test 6's second assertion passes on both the current and guarded source, but it is not reached in the RED run because the first assertion aborts that test.

Do not change the tests to make them pass in this task; Task 2 supplies the implementation.

- [ ] **Step 6: Confirm the editor test file is unchanged and still green**

Run: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`

Expected: PASS, `Tests  30 passed (30)`, with no modifications to `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts
git commit -m "test(workspace-tasks): pin panel identity-guard render contract"
```

## Task 2: Guard the three panel property setters and add the patch changeset

**Implementer tier:** Fast

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts:189-213` (`set context(value: WorkspacePanelContext | undefined)`)
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts:214-237` (`set workspaceTasksState(value: WorkspaceTasksPanelState)`)
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts:243-246` (`set workspaceTasksActions(value: WorkspaceTasksPanelActions)`)
- Create: `.changeset/workspace-tasks-panel-responsiveness.md`
- Test: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`
- Test: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`

**Interfaces:**

- Consumes: `WorkspacePanelContext` from `@hyperdreamer/pi-webui/plugin-api` and the module-private `contextKey(context: WorkspacePanelContext | undefined): string | undefined` in `tasksPanelElement.ts`, whose key already covers `context.machine.id`, `context.workspace.projectId`, `context.workspace.id`, and `context.workspace.path`. `contextKey` is unchanged by this task.
- Consumes: `WorkspaceTasksPanelState = { readonly workspace: WorkspaceCatalogState; readonly global: GlobalCatalogState; readonly sourceGenerations?: Readonly<Record<WorkspaceTaskScope, number>>; readonly move?: { readonly kind: "partial" | "unknown-outcome" | "conflict"; readonly message: string; readonly retryAllowed: boolean }; readonly moveError?: { readonly kind: "validation" | "unavailable"; readonly message: string }; readonly mutationGate?: { readonly scopes: readonly WorkspaceTaskScope[]; readonly message: string } }` as declared in `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- Consumes: `WorkspaceTasksPanelActions = { create(scope: WorkspaceTaskScope, task: WorkspaceTask): Promise<void>; update(ref: WorkspaceTaskRef, task: WorkspaceTask): Promise<void>; remove(ref: WorkspaceTaskRef): Promise<void>; move(ref: WorkspaceTaskRef, destinationTask: WorkspaceTask): Promise<void>; retryMove(): Promise<void>; refresh(): Promise<void> }` as declared in `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- Consumes: class `PiWebUiTasksPanel` fields `private contextValue: WorkspacePanelContext | undefined;`, `private stateValue: WorkspaceTasksPanelState = emptyPanelState();`, `private actionsValue: WorkspaceTasksPanelActions = noOpActions();`, and the private method `render(): void`.
- Consumes: the existing private members kept verbatim inside the target setter bodies: `recordPendingSourceObservations(value)`, `rememberOpenGroups()`, `pruneExpandedGroups()`, `reconcilePendingAction()`, `isMoveComplete(editor, value)`, and `focusTarget(target)`. Their declarations and behavior do not change.
- Consumes: the RED tests produced by Task 1 in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`: `"does not rewrite the shadow DOM when context, state, and actions are re-assigned unchanged"`, `"treats a structurally identical state clone as a change and rewrites the shadow DOM"`, `"renders updated task content for a state object with different tasks"`, `"resets panel state when the context key changes"`, `"uses the newest context terminal facade after a skipped re-render"`, and `"leaves the DOM untouched for identical actions and rewrites it for a new actions object"`, plus the updated test `"renders native collapsed details groups with counts and preserves expansion by scoped group key"`.
- Produces: guarded `set context(value: WorkspacePanelContext | undefined)`, `set workspaceTasksState(value: WorkspaceTasksPanelState)`, and `set workspaceTasksActions(value: WorkspaceTasksPanelActions)` in `PiWebUiTasksPanel`, with the storage getters unchanged: `get workspaceTasksState(): WorkspaceTasksPanelState { return this.stateValue; }` and `get workspaceTasksActions(): WorkspaceTasksPanelActions { return this.actionsValue; }`.
- Produces: `.changeset/workspace-tasks-panel-responsiveness.md` with the exact body stated in Global Constraints.

- [ ] **Step 1: Change only the context skip branch**

In `set context`, leave the first three statements exactly as they are, including the unconditional `this.contextValue = value;`. Replace the whole `if (previousKey === nextKey) { this.render(); return; }` block with exactly this single line:

```ts
    if (previousKey === nextKey && nextKey !== undefined) return;
```

The full target setter must read exactly:

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

Ordering rules: `previousKey` and `nextKey` are computed before the assignment; `this.contextValue = value` stays unconditional before the early return; the reset block lines after the return are copied verbatim and must not change. The `nextKey !== undefined` clause is load-bearing: `undefined -> undefined` must fall through to the reset block and `this.render()` so a context-less panel still renders the "Select a workspace." placeholder as it does today; a defined, unchanged key skips.

- [ ] **Step 2: Add the state identity guard as the first statement**

Insert exactly this line as the first statement in `set workspaceTasksState`, before `const previous = this.stateValue;`:

```ts
    if (value === this.stateValue) return;
```

The full target setter must read exactly:

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

Do not change `recordPendingSourceObservations`, move-recovery, reconciliation, focus, or render logic. Do not change `get workspaceTasksState(): WorkspaceTasksPanelState { return this.stateValue; }`.

- [ ] **Step 3: Add the actions identity guard as the first statement**

Insert exactly this line as the first statement in `set workspaceTasksActions`, before `this.actionsValue = value;`:

```ts
    if (value === this.actionsValue) return;
```

The full target setter must read exactly:

```ts
  set workspaceTasksActions(value: WorkspaceTasksPanelActions) {
    if (value === this.actionsValue) return;
    this.actionsValue = value;
    this.render();
  }
```

Do not change `get workspaceTasksActions(): WorkspaceTasksPanelActions { return this.actionsValue; }` or any other method.

- [ ] **Step 4: Create the changeset file**

Create `.changeset/workspace-tasks-panel-responsiveness.md` with exactly:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Keep the Workspace Tasks panel responsive while sessions stream.
```

- [ ] **Step 5: Run the focused panel tests and confirm green**

Run: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts`

Expected: PASS, `Tests  11 passed (11)` — the 5 existing tests plus the 6 new tests. Tests 1 and 6 now pass because the guards skip the unchanged-input renders.

- [ ] **Step 6: Run the editor test file and confirm green**

Run: `npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`

Expected: PASS, `Tests  30 passed (30)`. Its `createControllableBridge().publish()` delivers a fresh `cloneBridgeState()` on every publish, so every published state crosses the identity guard and the file needs no modification.

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`

Expected: PASS, exit 0 with no diagnostics.

- [ ] **Step 8: Commit**

```bash
git add pi-webui-plugins/workspace-tasks/tasksPanelElement.ts .changeset/workspace-tasks-panel-responsiveness.md
git commit -m "fix(workspace-tasks): skip panel renders for unchanged inputs"
```
