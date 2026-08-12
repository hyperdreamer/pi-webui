# Recent-Project History Removal Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add confirmed row-end removal controls for registered and Closed Recent Projects entries while preserving direct registered selection, the Closed-entry decision flow, machine isolation, and automatic history recreation after later meaningful work.

**Architecture:** The project store makes history deletion independent of registration and remains the authoritative serialized writer. `RecentProjectController` applies authoritative responses without the obsolete registration-conflict path. `RecentProjectsPanel` renders two sibling controls per row and supplies explicit cancel and post-removal focus closures; one generalized `RecentProjectDialog` owns Closed actions and in-place confirmation; `PiWebUiApp` owns machine-scoped modal generation and transport wiring.

**Tech Stack:** TypeScript with strict optional-property semantics, Fastify 5, Lit 3, Vitest 4 with jsdom, CSS media queries, and Changesets.

## Global Constraints

- Implement `docs/superpowers/specs/2026-08-13-recent-project-history-removal-controls-design.md`, including the audit corrections committed in `e3fa514`.
- Registered-row activation selects directly; Closed-row activation opens Reopen / Remove from history / Cancel; an `X` on either row type opens removal confirmation directly.
- Every removal path requires confirmation. Cancel, Escape, and backdrop dismiss the whole dialog rather than acting as Back; while busy, all buttons are disabled and Escape/backdrop are ignored.
- Removal changes Recent Projects history only. It must not unregister or close projects, stop sessions or terminals, delete workspaces, mutate files, or add a permanent exclusion list.
- Later meaningful work on a removed registered project must recreate a fresh history entry through the existing record-work API.
- Preserve machine-scoped serialization, generation guards, stale-response suppression, and no-focus-restoration behavior on machine change.
- Keep `onOpenRegistered` and `onOpenClosed` as component interfaces. Add `onRemoveRequested(entry, cancelFocus, removalFocus)` only for row-end removal.
- The Closed-row restore closure may keep its existing signature but must focus the original primary action when present and fall back to next, previous, or empty state after successful removal.
- Use a non-interactive row container with sibling primary and remove buttons; never nest an interactive control inside a `role="button"` row.
- Reserve a fixed action slot. Hide the `X` visually on hover-capable devices until `:hover` or `:focus-within`; keep it keyboard reachable and visible under `@media (hover: none)`.
- Use an inline stroke `X` icon matching existing project close controls, with tooltip and accessible label `Remove <name> from Recent Projects`.
- Rename `ClosedRecentProjectDialog` / `closed-recent-project-dialog` to `RecentProjectDialog` / `recent-project-dialog` and remove the obsolete component after host migration.
- No new runtime dependencies. Keep README and user configuration documentation unchanged. Do not edit `CHANGELOG.md` directly.
- Add one minor Changeset for `@hyperdreamer/pi-webui` describing removal for open and Closed history entries, confirmation, and reappearance after future work.
- Follow red-green TDD at the narrowest useful layer. Run focused tests first, then TypeScript, ESLint, Knip, `npm run verify:fast`, and serial `npm run verify`; never use `git commit --no-verify`.
- This feature changes only web/API/client code. No session-daemon restart is required.

## Task 1: Permit registered-entry removal at the server boundary

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/storage/projectStore.ts:162-209`
- Test: `src/server/storage/projectStore.recentProjects.test.ts:126-149`
- Modify: `src/server/projects/projectService.ts:1-66`
- Test: `src/server/projects/projectService.recentProjects.test.ts:1-88`
- Modify: `src/server/app.ts:1-20,151-163`
- Test: `src/server/app.recentProjects.test.ts:40-67`

**Interfaces:**

- Consumes: existing `ProjectStore.exclusive`, parsed `{ projects, recentProjects }`, and `ProjectNotFoundError` route mapping.
- Produces:

```ts
export type RecentRemoval =
  | { kind: "removed"; entries: RecentProjectEntry[] }
  | { kind: "not-found" };

ProjectStore.removeRecent(entryId: string): Promise<RecentRemoval>;
ProjectService.removeRecent(entryId: string): Promise<RecentProjectEntry[]>;
```

- Removes: `RecentRemoval`'s `{ kind: "registered" }` variant and `RecentProjectRegisteredError`.
- Preserves: unknown entry `404`, malformed-history and persistence failures, atomic write serialization, and the registered `projects` array unchanged.

- [ ] **Step 1: Write failing store, service, and route tests**

Change the store test to remove the entry while its project is still registered, then assert the project remains in `store.list()`. Record the removed entry ID, call `store.removeRecent(entry.id)`, and assert:

```ts
expect(removal).toEqual({
  kind: "removed",
  entries: [expect.objectContaining({ path: "/work/beta" })],
});
expect((await store.list()).map((project) => project.path)).toEqual([
  "/work/alpha",
  "/work/beta",
]);
expect(await store.removeRecent(entry.id)).toEqual({ kind: "not-found" });
```

Then call `store.touchRecent(alpha.id)` and assert the recreated `/work/alpha` entry is first and has a different ID from the removed entry.

Change the service test to remove a registered entry successfully, assert `service.list()` still contains both projects, assert an unknown history ID throws `ProjectNotFoundError`, and call `service.recordRecent(alpha.id)` to verify a fresh history ID appears first.

Change the route test that currently expects `409` so DELETE succeeds while registered, GET `/api/projects` still contains the project, the returned history is empty, a second DELETE answers `404`, and POST `/api/projects/:id/recent` recreates an entry with a fresh ID. Repeat successful DELETE through `/api/machines/local/recent-projects/:entryId` so both local registrations are covered.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run src/server/storage/projectStore.recentProjects.test.ts src/server/projects/projectService.recentProjects.test.ts src/server/app.recentProjects.test.ts
```

Expected: FAIL because `ProjectStore.removeRecent` returns `registered`, `ProjectService` throws `RecentProjectRegisteredError`, and the route returns `409`. Confirm the failure is the registered-path refusal, not setup or parsing.

- [ ] **Step 3: Remove the registered-path refusal and obsolete error type**

In `ProjectStore.removeRecent`, keep the lookup and `not-found` result, delete the registered-project path guard, filter by history ID, write `{ ...data, recentProjects }`, and return `{ kind: "removed", entries: recentProjects }`.

Remove the `registered` union variant. In `ProjectService.removeRecent`, retain only the `not-found` translation and return removed entries. Delete `RecentProjectRegisteredError` and its import/use in `app.ts`; `sendProjectRouteError` maps `ProjectNotFoundError` to `404` and all genuine failures to `500`.

Do not alter the browser DELETE path, parser, federation allowlist, project registration, or touch semantics.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/server/storage/projectStore.recentProjects.test.ts src/server/projects/projectService.recentProjects.test.ts src/server/app.recentProjects.test.ts src/client/src/api/clients.recentProjects.test.ts src/client/src/api/federatedRouteContract.test.ts
npm run typecheck
npx eslint src/server/storage/projectStore.ts src/server/storage/projectStore.recentProjects.test.ts src/server/projects/projectService.ts src/server/projects/projectService.recentProjects.test.ts src/server/app.ts src/server/app.recentProjects.test.ts
npx knip
```

Expected: all focused tests and static checks pass; Knip reports no new unused server symbols.

- [ ] **Step 5: Commit**

```bash
git add src/server/storage/projectStore.ts src/server/storage/projectStore.recentProjects.test.ts src/server/projects/projectService.ts src/server/projects/projectService.recentProjects.test.ts src/server/app.ts src/server/app.recentProjects.test.ts
git commit -m "feat(projects): remove registered entries from recent history"
```

## Task 2: Simplify client removal orchestration

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/recentProjectController.ts:1-175`
- Test: `src/client/src/controllers/recentProjectController.test.ts:1-449`
- Modify: `src/client/src/components/PiWebUiApp.ts:332-340,2449-2458`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.test.ts:1-258`

**Interfaces:**

- Consumes: Task 1's DELETE contract, which either returns the authoritative `RecentProjectEntry[]` or rejects; registration never produces a `409` conflict.
- Produces:

```ts
export type RecentProjectRemovalOutcome = { kind: "removed" };
RecentProjectController.removeEntry(entryId: string): Promise<RecentProjectRemovalOutcome>;
```

- Removes: `RecentProjectControllerDependencies.reconcileProjects`, `reconcileRemovalConflict`, `HttpRequestError` coupling, registered-conflict outcome, and the app-level conflict error handler.
- Preserves: queueing per machine, deletion of `latestIntentByMachine` and `authoritativeProjectIdByMachine` before removal, authoritative response publication, stale-generation suppression, and thrown ordinary failures.

- [ ] **Step 1: Replace conflict tests with failing pass-through and recreation tests**

In `recentProjectController.test.ts`, remove the full/partial registered-conflict reconciliation tests. Add a test that makes `removeRecentProject` reject `new HttpRequestError("Machine offline", 503)`, then asserts `removeEntry` rejects the exact error, `recentProjects` is not called for reconciliation, and current ready history remains unchanged.

Add a recency reset test:

```ts
await controller.load();
controller.recordWork("project-alpha");
await vi.waitFor(() => expect(recordRecentProject).toHaveBeenCalledTimes(1));
await controller.removeEntry("entry-alpha");
controller.recordWork("project-alpha");
await vi.waitFor(() => expect(recordRecentProject).toHaveBeenCalledTimes(2));
```

Use ordered authoritative responses so the second touch recreates `/work/alpha` first. Remove `reconcileProjects` from the harness signature and controller construction.

In `PiWebUiApp.recentProjects.test.ts`, replace the reconciled-conflict test with a narrow wiring test asserting the rendered `.onRemove` handler rejects a generic removal failure and does not set `state.error`; the dialog component will own visible errors in Task 4. This test must fail while the app still expects `outcome.kind === "registered-conflict"` or reconciles through the controller.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- --run src/client/src/controllers/recentProjectController.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts
```

Expected: FAIL because the controller still performs registered-conflict reconciliation and its dependencies/type still expose that branch. Confirm the pass-through assertion observes an unwanted history reload or conflict result.

- [ ] **Step 3: Remove the conflict branch and simplify host wiring**

Drop `HttpRequestError` from the controller import. Change `RecentProjectRemovalOutcome` to the single removed variant. Remove `reconcileProjects` from dependencies, delete `reconcileRemovalConflict`, and make the queued remove operation publish returned entries or capture and rethrow an ordinary `Error`.

In the `PiWebUiApp` controller construction, remove the `reconcileProjects` callback. In its current recent-project remove handler, await `removeEntry(entry.id)` without inspecting an outcome or setting app-level error. Task 5 will replace the surrounding modal host, but this task must leave TypeScript and existing focused tests green.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/client/src/controllers/recentProjectController.test.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts
npm run typecheck
npx eslint src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts
npx knip
```

Expected: tests and static checks pass with no `registered-conflict`, `reconcileRemovalConflict`, or `RecentProjectRegisteredError` production references.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/recentProjectController.ts src/client/src/controllers/recentProjectController.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts
git commit -m "refactor(client): simplify recent history removal"
```

## Task 3: Add row-end removal controls and focus closures

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/RecentProjectsPanel.ts:1-103`
- Test: `src/client/src/components/RecentProjectsPanel.test.ts:1-187`

**Interfaces:**

- Consumes: existing `onOpenRegistered(project)` and `onOpenClosed(entry, restoreFocus)` callbacks and server-ordered `RecentProjectsState`.
- Produces:

```ts
@property({ attribute: false })
onRemoveRequested?: (
  entry: RecentProjectEntry,
  cancelFocus: () => void,
  removalFocus: () => void,
) => void;
```

- `onOpenClosed` keeps its current signature. Its `restoreFocus` closure focuses the original primary action if present; if the entry disappeared, it focuses next primary action by original index, otherwise previous, otherwise `.recent-projects-empty`.
- `cancelFocus` focuses the originating `.recent-project-remove` button while it exists.
- `removalFocus` always uses next/previous/empty fallback by the removed entry's original index.

- [ ] **Step 1: Replace the no-controls test with failing DOM interaction tests**

Delete the existing `"renders no per-row removal control"` assertion. Add tests that mount registered and Closed entries and assert each row has:

```ts
button.recent-project-open
button.recent-project-remove[title="Remove alpha from Recent Projects"]
```

Assert the outer `.recent-project-row` has no `role="button"` and no `tabindex`, while the primary button owns the path title, project-specific `aria-label`, and keyboard focus.

Add an interaction test that clicks each remove button and asserts `onRemoveRequested` receives the corresponding entry and two functions, while neither `onOpenRegistered` nor `onOpenClosed` fires. Focus the remove button and activate it with `.click()` to prove the keyboard-focus path uses the same callback.

Add focus tests:

- Closed-row Enter still calls `onOpenClosed`; its closure focuses the current primary action on cancellation.
- Captured `removalFocus` focuses the next entry after the state removes the selected entry.
- Removing the last entry focuses the previous entry.
- Removing the sole entry focuses `.recent-projects-empty`, which has `tabindex="-1"`.

Add CSS contract assertions against `RecentProjectsPanel.styles.cssText`: fixed remove dimensions; default `opacity: 0` and `pointer-events: none`; `:hover` and `:focus-within` reveal it; `@media (hover: none)` keeps it visible; row/open/remove layout rules preserve the action slot.

- [ ] **Step 2: Run the panel tests and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts
```

Expected: FAIL because no remove buttons, sibling primary action, focus closures, focusable empty state, or visibility CSS exist. Confirm registered and Closed activation assertions still describe the current preserved behavior.

- [ ] **Step 3: Implement sibling row controls and deterministic focus**

Render `.recent-project-row.action-row` as a non-interactive grid container with `data-recent-project-id`. Render the primary content as `button.recent-project-open.action-main`, preserving selected styling, path title, accessible label, activity indicator, and existing click behavior. Native button Enter/Space behavior replaces the manual row keydown handler.

Render `button.recent-project-remove` as the trailing sibling. Use the existing project close icon path in an inline stroke SVG:

```html
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="m6 6 12 12M18 6 6 18"></path>
</svg>
```

Its `title` and `aria-label` are `Remove ${entry.name} from Recent Projects`. Stop propagation and call `onRemoveRequested` with closures that re-query the current rendered DOM rather than retaining disconnected elements.

Capture the original server-order index when opening either flow. Implement focus helpers that wait for `this.updateComplete`, query current rows, and focus primary/remove/empty targets according to the interface above. Give the ready empty-state paragraph class `recent-projects-empty` and `tabindex="-1"`.

Use a fixed 32px trailing button slot, zero border-left, matching right corners, inline SVG, and no content shift. On hover-capable defaults hide by opacity while preserving keyboard order; `.recent-project-row:hover` and `.recent-project-row:focus-within` reveal it. Under `@media (hover: none)`, force visible and pointer-enabled.

- [ ] **Step 4: Run panel tests and static checks**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectsPanel.test.ts
npm run typecheck
npx eslint src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts
npx knip
```

Expected: all panel tests and static checks pass; the row's primary and removal controls are separate keyboard stops.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts
git commit -m "feat(client): add recent project row removal controls"
```

## Task 4: Build the generalized two-view recent-project dialog

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
- Removes no old component in this task; Task 5 migrates the host and deletes it so intermediate app imports remain valid.

- [ ] **Step 1: Write failing dialog tests**

Create a jsdom harness using the existing native `HTMLDialogElement.showModal` and `close` stubs. Cover:

- `initialView="closed-actions"` identifies name/path, says the project is no longer registered, renders Reopen / Remove from history / Cancel, and focuses Reopen.
- Clicking Remove from history does not invoke `onRemove`; it transitions in place to confirmation and focuses Cancel.
- `initialView="removal-confirmation"` renders confirmation directly, focuses Cancel, and explains that only Recent Projects history changes, files are not deleted, registration is unaffected, and future work can add the entry again.
- Confirmation Remove invokes `onRemove(entry)` once and calls `onClose` only after success.
- Reopen invokes `onReopen(entry)` and closes only after success.
- A rejected action leaves the current view open, shows the specific error with alert/status semantics, and re-enables actions.
- Cancel, native cancel/Escape, and backdrop click call `onClose` from either view when idle.
- With a deferred action running, all buttons are disabled and Escape/backdrop/Cancel do not call `onClose`; resolution closes once.
- The dialog frame remains width-bounded at narrow viewports and exposes modal labeling and `aria-busy`.

- [ ] **Step 2: Run the new dialog test and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectDialog.test.ts
```

Expected: FAIL with `Cannot find module './RecentProjectDialog'`. The failure must be the absent component, not jsdom dialog setup.

- [ ] **Step 3: Implement the two-view dialog**

Adapt the current Closed dialog's native modal, frame, async error handling, and explicit `close()` method. Add `initialView` and internal current-view state. Reset current view and failure when a new entry/initial view arrives. Closed-actions Remove only switches view; after `updateComplete`, focus `.recent-project-cancel`.

The confirmation heading is `Remove from Recent Projects?`. Use concise copy that is accurate for both entry kinds: only the history entry is removed; project files and any registration remain unchanged; future meaningful work can add it again. Style the confirmed Remove as the destructive action without introducing nested cards or another modal.

Guard `run()` against reentry. While busy, disable every button, expose `aria-busy="true"`, and ignore native cancel and backdrop clicks. On action failure, retain the current view and show the exact error. On action success, call `onClose` once.

Use the existing width and backdrop variables and keep the frame at 8px border radius or less.

- [ ] **Step 4: Run dialog tests and static checks**

Run:

```bash
npm test -- --run src/client/src/components/RecentProjectDialog.test.ts
npm run typecheck
npx eslint src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts
npx knip
```

Expected: dialog tests and static checks pass; Knip accepts the test-consumed component until Task 5 imports it in production.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts
git commit -m "feat(client): confirm recent project history removal"
```

## Task 5: Integrate modal state, focus restoration, and release metadata

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:90-100,385-400,615-625,1458-1472,1549-1561,2439-2498,4600-4615`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.test.ts:1-258`
- Test: `src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts:1-581`
- Delete: `src/client/src/components/ClosedRecentProjectDialog.ts`
- Delete: `src/client/src/components/ClosedRecentProjectDialog.test.ts`
- Create: `.changeset/recent-project-history-removal-controls.md`

**Interfaces:**

- Consumes from Task 2: `RecentProjectController.removeEntry(entryId): Promise<{ kind: "removed" }>` with thrown failures and authoritative state publication.
- Consumes from Task 3:

```ts
onOpenClosed(entry, restoreFocus): void;
onRemoveRequested(entry, cancelFocus, removalFocus): void;
```

- Consumes from Task 4: `RecentProjectDialog`, `RecentProjectDialogView`, `initialView`, `onReopen`, `onRemove`, `onClose`, and `close()`.
- Produces app-owned modal state equivalent to:

```ts
@state() private recentProjectDialogEntry: RecentProjectEntry | undefined;
private recentProjectDialogMachineId: string | undefined;
private recentProjectDialogInitialView: RecentProjectDialogView = "closed-actions";
private recentProjectDialogCancelFocus: (() => void) | undefined;
private recentProjectDialogRemovalFocus: (() => void) | undefined;
private recentProjectDialogGeneration = 0;
```

- Closed-row flow stores the same smart row closure as both cancel and removal focus. Direct `X` flow stores distinct cancel/remove closures.

- [ ] **Step 1: Write failing host integration and focus tests**

Update imports, type aliases, selectors, and registration assertions from `ClosedRecentProjectDialog` / `closed-recent-project-dialog` to `RecentProjectDialog` / `recent-project-dialog`. Assert the old element is not used by `PiWebUiApp`.

Adapt existing Closed-row tests to the new classes and two-step removal: clicking `.recent-project-remove-request` first shows confirmation and does not call the API; clicking `.recent-project-confirm-remove` performs removal. Preserve direct registered selection and Closed-row decision behavior.

Add direct-removal tests through the real panel callback:

- Registered row `X` opens `initialView="removal-confirmation"` without selecting the project.
- Closed row `X` opens confirmation directly rather than Closed actions.
- Cancel from direct confirmation restores focus to the current `X` button.
- Cancel after Closed actions transition to confirmation closes the whole modal and restores the Closed row primary action, never acts as Back.
- Successful removal focuses the next row, otherwise previous row, otherwise `.recent-projects-empty`.
- Registered removal leaves `appState(app).projects` unchanged.
- A generic remove failure keeps confirmation open and displays the exact error without setting global `state.error`.
- Reopen success/failure retains existing behavior and focus.
- Machine change closes without invoking either stale focus closure.
- A deferred action from dialog A cannot close dialog B or restore focus into its old machine/generation.

Update the busy-state host test: while the operation is pending, Cancel is disabled and Escape/backdrop do not dismiss. Resolve the operation before opening dialog B, then assert the stale completion cannot affect B.

Update `PiWebUiApp.recentProjects.test.ts` to assert `customElements.get("recent-project-dialog")` is defined, remove the obsolete registered-conflict expectations, and inspect `.initialView`, `.onReopen`, and `.onRemove` wiring through stable semantic markers only where the narrow non-DOM harness remains proportionate.

- [ ] **Step 2: Run host-focused tests and verify RED**

Run:

```bash
npm test -- --run src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts src/client/src/components/RecentProjectsPanel.test.ts src/client/src/components/RecentProjectDialog.test.ts
```

Expected: FAIL because `PiWebUiApp` still imports/renders the Closed-only component, does not pass `onRemoveRequested`, and lacks initial-view plus dual focus state. Confirm failures occur at the new selectors or expected callbacks, not harness setup.

- [ ] **Step 3: Replace Closed-only app state with generalized modal state**

Import `./RecentProjectDialog` for registration and import its type plus `RecentProjectDialogView`. Remove the old import. Rename the state and helper methods to `recentProjectDialog*` / `renderRecentProjectDialog`, and include the generalized entry in `hasOpenModal`.

In `renderRecentProjectsTab`, preserve `onOpenRegistered` and `onOpenClosed`. Add `onRemoveRequested` and open the modal with `"removal-confirmation"`. Closed-row activation opens with `"closed-actions"` and stores its smart row closure as both cancel and removal focus.

Render `<recent-project-dialog>` with `.entry` and `.initialView`. Reopen keeps current project registration/history reload behavior. Remove awaits `recentProjects.removeEntry(entry.id)` and, only if machine/entry/generation still match, closes through a removal-success path that schedules `removalFocus`. Generic errors are allowed to reject back into the component.

Idle `onClose` closes through a cancel path and schedules `cancelFocus`. The shared close helper checks machine, entry, and generation; calls the native component `close()` while connected; clears all stored callbacks/state; and after `this.updateComplete` invokes only the chosen focus closure if no newer dialog exists and the selected machine still matches. Machine-change closure passes no focus mode.

Delete `ClosedRecentProjectDialog.ts` and its test after all imports/selectors have migrated. Do not leave a compatibility custom element because the audited spec requires the rename and the old registration test is replaced.

- [ ] **Step 4: Add the Changeset and run focused plus broad verification**

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

Expected: focused tests, typecheck, ESLint, Knip, fast verification, serial verification, and Changesets status all pass. Knip may print only existing configuration hints.

Use the project Chromium/CDP layout-probe procedure against desktop and narrow/touch-like viewports. Verify the `X` is hidden until hover/focus on hover-capable desktop, visible without hover on touch emulation, has a stable 32px slot, long path text does not overlap it, both dialog views fit the viewport, and the app canvas is nonblank. Record the measured viewport and bounding boxes in the implementation report; do not commit probe output.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.recentProjects.test.ts src/client/src/components/PiWebUiApp.recentProjects.focus.test.ts src/client/src/components/RecentProjectDialog.ts src/client/src/components/RecentProjectDialog.test.ts src/client/src/components/RecentProjectsPanel.ts src/client/src/components/RecentProjectsPanel.test.ts .changeset/recent-project-history-removal-controls.md
git add -u src/client/src/components/ClosedRecentProjectDialog.ts src/client/src/components/ClosedRecentProjectDialog.test.ts
git commit -m "feat(client): remove projects from recent history"
```
