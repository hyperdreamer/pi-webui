# Recent-Project History Removal Controls Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the approved Recent Projects removal feature after the original run proved that splitting the row-control change from its importing focus tests made the normal pre-commit gate impossible to satisfy.

**Architecture:** This continuation inherits the approved server and client-orchestration commits and preserves the blocked panel implementation as a hash-pinned patch. Task 1 combines that panel change with the dependent focus-test selector migration so the hook stays green; Task 2 adds the generalized two-view dialog; Task 3 performs app integration, removes the old dialog, adds release metadata, and verifies the whole branch from the original merge base.

**Tech Stack:** TypeScript with strict optional-property semantics, Fastify 5, Lit 3, Vitest 4 with jsdom, CSS media queries, Chromium/CDP layout probing, and Changesets.

## Global Constraints

- Implement `docs/superpowers/specs/2026-08-13-recent-project-history-removal-controls-design.md`, including the audit corrections committed in `e3fa514`.
- Inherit and preserve approved commits `b7579dbd61f1c7a577d172c58dbdbc983703fd2b` and `4caae1415fd829a65f619892c8d91d4a579c952e`; do not rewrite or squash them during task execution.
- The original run at `.sdd/recent-project-history-removal-controls` is terminal `TASK_BLOCKED` revision 25. Never edit its `state.json` or `progress.md`; its blocked deliverable is archived read-only at `.sdd/recent-project-history-removal-controls/task-3-blocked-deliverable.patch` with SHA-256 `8c07ec91a3471c0e4d90357d6c57d7dd19af9680553ba5ec381587dead126a0e`.
- Registered-row activation selects directly; Closed-row activation opens Reopen / Remove from history / Cancel; an `X` on either row type opens removal confirmation directly.
- Every removal path requires confirmation. Cancel, Escape, and backdrop dismiss the whole dialog rather than acting as Back; while busy, all buttons are disabled and Escape/backdrop are ignored.
- Removal changes Recent Projects history only. It must not unregister or close projects, stop sessions or terminals, delete workspaces, mutate files, or add a permanent exclusion list.
- Later meaningful work on a removed registered project must recreate a fresh history entry through the existing record-work API.
- Preserve machine-scoped serialization, generation guards, stale-response suppression, and no-focus-restoration behavior on machine change.
- Keep `onOpenRegistered` and `onOpenClosed` as component interfaces. Add `onRemoveRequested(entry, cancelFocus, removalFocus)` only for row-end removal.
- Use a non-interactive row container with sibling primary and remove buttons; never nest an interactive control inside a `role="button"` row.
- Reserve a fixed action slot. Hide the `X` visually on hover-capable devices until `:hover` or `:focus-within`; keep it keyboard reachable and visible under `@media (hover: none)`.
- Use an inline stroke `X` icon matching existing project close controls, with tooltip and accessible label `Remove <name> from Recent Projects`.
- Rename `ClosedRecentProjectDialog` / `closed-recent-project-dialog` to `RecentProjectDialog` / `recent-project-dialog` and remove the obsolete component after host migration.
- No new runtime dependencies. Keep README and user configuration documentation unchanged. Do not edit `CHANGELOG.md` directly.
- Add one minor Changeset for `@hyperdreamer/pi-webui` describing removal for open and Closed history entries, confirmation, and reappearance after future work.
- Follow red-green TDD at the narrowest useful layer. Every task must leave `npm run verify:fast` and serial `npm run verify` green before committing normally; never use `git commit --no-verify` and never disable or alter `.githooks/pre-commit`.
- Final review must inspect the whole feature branch from original merge base `e7eec29b43e6322bd46ea9724a404de494888925`, including inherited plans/specs and approved Tasks 1-2 from the original run.
- This feature changes only web/API/client code. No session-daemon restart is required.

## Task 1: Recover row controls with hook-safe focus-test migration

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/RecentProjectsPanel.ts:1-103`
- Test: `src/client/src/components/RecentProjectsPanel.test.ts:1-187`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts:150-470`
- Read only: `.sdd/recent-project-history-removal-controls/task-3-blocked-deliverable.patch`
- Read only: `.sdd/recent-project-history-removal-controls/task-3-implementer-report.md`

**Interfaces:**

- Consumes the existing callbacks:

```ts
onOpenRegistered?: (project: Project) => void;
onOpenClosed?: (entry: RecentProjectEntry, restoreFocus: () => void) => void;
```

- Produces:

```ts
onRemoveRequested?: (
  entry: RecentProjectEntry,
  cancelFocus: () => void,
  removalFocus: () => void,
) => void;
```

- `onOpenClosed` keeps its current signature. Its restore closure focuses the current primary button for the original entry, otherwise next primary by original index, otherwise previous primary, otherwise `.recent-projects-empty`.
- `cancelFocus` focuses the current `.recent-project-remove` for the original entry; `removalFocus` uses next/previous/empty fallback by original index.
- The app focus test exposes separate helpers: `recentRow()` returns the non-interactive container only when connection state is under test; `recentPrimary()` returns `button.recent-project-open` for activation and focus assertions.

- [ ] **Step 1: Migrate the dependent focus tests first and verify RED**

In `PiWebUiApp.recentProjects.focus.test.ts`, add:

```ts
function recentPrimary(panel: RecentProjectsPanelElement, entryId = entry.id): HTMLButtonElement {
  const primary = recentRow(panel, entryId).querySelector<HTMLButtonElement>("button.recent-project-open");
  if (primary === null) throw new Error(`Expected recent project primary action ${entryId}`);
  return primary;
}
```

Keep `recentRow()` returning the outer container. Replace every row activation with `recentPrimary(panel, id).click()`. For the keyboard-focused Cancel case, focus `recentPrimary`, activate it with `.click()`, and assert restored shadow-root focus equals the newly rendered `recentPrimary`, not the container. Replace all other focus expectations with primary buttons.

Where tests currently use `Reflect.set(panel, "focusEntry", restoreLocalFocus)`, use `Reflect.set(panel, "restoreClosedFocus", restoreLocalFocus)` because the new closure calls that method. Keep container references only for `isConnected` and row-absence assertions; use primary references for activation and active-element assertions.

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
```

Expected: FAIL because the current panel has no `button.recent-project-open`. This proves the dependent selector migration will fail until the recovered panel implementation lands.

- [ ] **Step 2: Verify and apply the blocked deliverable patch**

Run:

```bash
sha256sum .sdd/recent-project-history-removal-controls/task-3-blocked-deliverable.patch
git apply --check .sdd/recent-project-history-removal-controls/task-3-blocked-deliverable.patch
git apply .sdd/recent-project-history-removal-controls/task-3-blocked-deliverable.patch
```

The hash must equal `8c07ec91a3471c0e4d90357d6c57d7dd19af9680553ba5ec381587dead126a0e`. The patch must modify only `RecentProjectsPanel.ts` and `RecentProjectsPanel.test.ts`.

Inspect the applied code and retain these contracts:

- non-interactive `.recent-project-row` container with sibling `button.recent-project-open.action-main` and `button.recent-project-remove`;
- project-specific tooltip and accessible label, exact inline stroke X path, event propagation stop, and fixed 32px slot;
- default opacity/pointer-event hiding, `:hover` and `:focus-within` reveal, and `@media (hover: none)` visibility;
- focus closures that await `updateComplete`, guard `isConnected`, and re-query current DOM;
- ready empty-state paragraph with `.recent-projects-empty` and `tabindex="-1"`;
- panel tests covering structure, activation isolation, CSS contract, cancel focus, next/previous/empty fallback, and preserved registered/Closed activation.

Do not edit the archived patch or old run artifacts.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
```

Expected: both files pass. The focus tests must open the existing Closed dialog through the primary button and restore focus to primary buttons, while the panel tests pass 20/20.

- [ ] **Step 4: Run static and broad verification**

Run:

```bash
npm run typecheck
npx eslint src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
npx knip
npm run verify:fast
npm run verify
```

Expected: all checks pass. Unlike the blocked original task, `verify:staged` must now include a green `PiWebUiApp.recentProjects.focus.test.ts`.

- [ ] **Step 5: Commit normally**

```bash
git add src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
git commit -m "feat(client): add recent project row removal controls"
```

The normal pre-commit hook must pass; do not bypass it.

## Task 2: Add the generalized two-view recent-project dialog

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/RecentProjectDialog.ts`
- Test: `src/client/src/components/RecentProjectDialog.test.ts`

**Interfaces:**

- Consumes: `RecentProjectEntry` and injected async Reopen/Remove callbacks.
- Produces:

```ts
export type RecentProjectDialogView =
  | "closed-actions"
  | "removal-confirmation";

@customElement("recent-project-dialog")
export class RecentProjectDialog extends LitElement {
  entry: RecentProjectEntry;
  initialView: RecentProjectDialogView;
  onReopen: (entry: RecentProjectEntry) => Promise<void>;
  onRemove: (entry: RecentProjectEntry) => Promise<void>;
  onClose: () => void;
  close(): void;
}
```

- Closed-actions view classes: `.recent-project-reopen`, `.recent-project-remove-request`, `.recent-project-cancel`.
- Confirmation view classes: `.recent-project-confirm-remove`, `.recent-project-cancel`.
- The old component remains untouched in this task so existing app imports stay green until Task 3 migrates them.

- [ ] **Step 1: Write failing dialog tests**

Create a jsdom harness using native `HTMLDialogElement.showModal` and `close` stubs. Cover:

- `initialView="closed-actions"` identifies name/path, says the project is no longer registered, renders Reopen / Remove from history / Cancel, and focuses Reopen.
- Clicking Remove from history does not invoke `onRemove`; it transitions in place to confirmation and focuses Cancel.
- `initialView="removal-confirmation"` renders confirmation directly, focuses Cancel, and explains that only Recent Projects history changes, files are not deleted, registration is unaffected, and future work can add the entry again.
- Confirmation Remove invokes `onRemove(entry)` once and calls `onClose` only after success.
- Reopen invokes `onReopen(entry)` and closes only after success.
- A rejected action leaves the current view open, shows the specific error with alert/status semantics, and re-enables actions.
- Cancel, native cancel/Escape, and backdrop click call `onClose` from either view when idle.
- With a deferred action running, every button is disabled and Escape/backdrop/Cancel do not call `onClose`; resolution closes once.
- The dialog frame is width-bounded at narrow viewports and exposes modal labeling and `aria-busy`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectDialog.test.ts
```

Expected: FAIL with `Cannot find module './RecentProjectDialog'`.

- [ ] **Step 3: Implement the dialog**

Adapt the current Closed dialog's native modal, frame, async error handling, and explicit `close()` method. Add `initialView` and internal current-view state. Reset current view and failure when a new entry or initial view arrives. Closed-actions Remove only switches view; after `updateComplete`, focus `.recent-project-cancel`.

Use confirmation heading `Remove from Recent Projects?`. Copy must state that only the history entry is removed, project files and any registration remain unchanged, and future meaningful work can add it again. Style confirmed Remove as destructive without adding another modal or nested card.

Guard async actions against reentry. While busy, disable every button, expose `aria-busy="true"`, and ignore native cancel and backdrop clicks. On failure retain the view and show the exact error; on success call `onClose` once. Use existing color/backdrop variables and frame border radius no greater than 8px.

- [ ] **Step 4: Run tests and static/broad checks**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectDialog.test.ts
npm run typecheck
npx eslint src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts
npx knip
npm run verify:fast
npm run verify
```

Expected: all checks pass; the new test-consumed component produces no new Knip finding.

- [ ] **Step 5: Commit normally**

```bash
git add src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts
git commit -m "feat(client): confirm recent project history removal"
```

## Task 3: Integrate modal state, removal focus, and release metadata

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:90-100,385-400,615-625,1458-1472,1549-1561,2439-2498,4600-4615`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.test.ts:1-258`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts:1-581`
- Delete: `src/client/src/components/ClosedRecentProjectDialog.ts`
- Delete: `src/client/src/components/ClosedRecentProjectDialog.test.ts`
- Create: `.changeset/recent-project-history-removal-controls.md`

**Interfaces:**

- Consumes inherited `RecentProjectController.removeEntry(entryId): Promise<{ kind: "removed" }>` with thrown failures and authoritative state publication.
- Consumes from Task 1:

```ts
onOpenClosed(entry, restoreFocus): void;
onRemoveRequested(entry, cancelFocus, removalFocus): void;
```

- Consumes from Task 2: `RecentProjectDialog`, `RecentProjectDialogView`, `initialView`, `onReopen`, `onRemove`, `onClose`, and `close()`.
- Produces app-owned modal state equivalent to:

```ts
@state() private recentProjectDialogEntry: RecentProjectEntry | undefined;
private recentProjectDialogMachineId: string | undefined;
private recentProjectDialogInitialView: RecentProjectDialogView = "closed-actions";
private recentProjectDialogCancelFocus: (() => void) | undefined;
private recentProjectDialogRemovalFocus: (() => void) | undefined;
private recentProjectDialogGeneration = 0;
```

- Closed-row flow stores the same smart primary-row closure as cancel and removal focus. Direct `X` flow stores distinct cancel/remove closures.

- [ ] **Step 1: Write failing host integration and focus tests**

Update imports, type aliases, selectors, and registration assertions from `ClosedRecentProjectDialog` / `closed-recent-project-dialog` to `RecentProjectDialog` / `recent-project-dialog`. Assert the app no longer uses the old element.

Adapt Closed-row tests to the new classes and two-step removal: `.recent-project-remove-request` first changes to confirmation without calling the API; `.recent-project-confirm-remove` performs removal. Preserve registered-primary direct selection and Closed-primary decision behavior.

Add real-panel direct-removal tests:

- Registered row `X` opens `initialView="removal-confirmation"` without selecting the project.
- Closed row `X` opens confirmation directly rather than Closed actions.
- Cancel from direct confirmation restores focus to the current `X`.
- Cancel after Closed actions transition to confirmation closes the whole modal and restores the Closed primary button, never acts as Back.
- Successful removal focuses next primary, otherwise previous primary, otherwise `.recent-projects-empty`.
- Registered removal leaves `appState(app).projects` unchanged.
- Generic remove failure keeps confirmation open with the exact error and does not set global `state.error`.
- Reopen success/failure preserves existing behavior and focus.
- Machine change closes without invoking stale focus closures.
- A deferred action from dialog A cannot close dialog B or restore focus into its old machine/generation.

Update the prior busy-state host test: all buttons are disabled while pending and Escape/backdrop do not dismiss. Resolve the operation before opening dialog B, then assert stale completion cannot affect B.

Update the narrow non-DOM host test to assert `customElements.get("recent-project-dialog")`, remove obsolete conflict expectations, and inspect `.initialView`, `.onReopen`, and `.onRemove` only through stable semantic markers.

- [ ] **Step 2: Run host tests and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/RecentProjectDialog.test.ts
```

Expected: FAIL because `PiWebUiApp` still imports/renders the Closed-only component and does not pass `onRemoveRequested` or initial-view/focus state.

- [ ] **Step 3: Replace Closed-only host state with generalized state**

Import/register `./RecentProjectDialog` and import its type plus `RecentProjectDialogView`. Remove the old import. Rename state and helpers to `recentProjectDialog*` / `renderRecentProjectDialog`, and include the generalized entry in `hasOpenModal`.

In `renderRecentProjectsTab`, preserve `onOpenRegistered` and `onOpenClosed`; add `onRemoveRequested`. Closed primary opens `"closed-actions"` and stores its smart closure as both cancel and removal focus. `X` opens `"removal-confirmation"` with distinct closures.

Render `<recent-project-dialog>` with `.entry` and `.initialView`. Reopen retains registration/history reload behavior. Remove awaits `recentProjects.removeEntry(entry.id)` and, only if machine/entry/generation still match, closes through a removal-success path that schedules `removalFocus`. Let generic errors reject into the dialog.

Idle `onClose` uses the cancel path. The shared close helper checks machine, entry, and generation; calls native `close()` while connected; clears all callbacks/state; then after `this.updateComplete` invokes only the selected focus closure if no newer dialog exists and the machine still matches. Machine-change closure invokes neither focus path.

Delete `ClosedRecentProjectDialog.ts` and its test after imports/selectors migrate. Do not leave a compatibility custom element.

- [ ] **Step 4: Add the Changeset and verify the whole branch**

Create `.changeset/recent-project-history-removal-controls.md` exactly as:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add confirmed removal controls for open and Closed Recent Projects entries. Removed open projects stay registered and return to history after future meaningful work.
```

Run:

```bash
npm test -- --run src/server/storage/projectStore.recentProjects.test.ts src/server/projects/projectService.recentProjects.test.ts src/server/app.recentProjects.test.ts src/client/src/api/clients.recentProjects.test.ts src/client/src/controllers/recentProjectController.test.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/RecentProjectDialog.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts
npm run typecheck
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectDialog.ts
npx knip
npm run verify:fast
npm run verify
npm run changelog:status
```

Expected: all focused, static, fast, serial, and Changesets checks pass.

Use the project Chromium/CDP layout-probe procedure at desktop and narrow/touch-like viewports. Verify the `X` is hidden until hover/focus on hover-capable desktop, visible without hover on touch emulation, owns a stable 32px slot, long paths do not overlap it, both dialog views fit, and the canvas is nonblank. Record measured viewport/bounding boxes in the report; do not commit probe output.

- [ ] **Step 5: Commit normally**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts .changeset/recent-project-history-removal-controls.md
git add -u src/client/src/components/ClosedRecentProjectDialog.ts src/client/src/components/ClosedRecentProjectDialog.test.ts
git commit -m "feat(client): remove projects from recent history"
```

The normal pre-commit hook must pass. No session-daemon restart is required.
