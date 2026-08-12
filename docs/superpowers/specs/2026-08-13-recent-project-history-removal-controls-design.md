# Recent-project history removal controls - design

## Goal

Make Recent Projects history easy to curate without changing project registration or filesystem state. Every history row gets a row-end remove control. Removal is allowed for both registered and Closed entries, always requires confirmation, and remains temporary: later meaningful work on a registered project creates a fresh history entry.

This design supersedes the original Recent Projects decisions that prohibited per-row controls and allowed removal only for Closed entries. All other history, path-identity, machine-scope, and meaningful-work invariants remain unchanged.

## Accepted behavior

- Clicking a registered history row selects that project directly through the existing navigation flow.
- Clicking a Closed history row opens the existing decision flow with **Reopen**, **Remove from history**, and **Cancel**.
- Every registered and Closed row has an `X` remove button at its trailing edge.
- On hover-capable devices, the button appears while the row is hovered or contains keyboard focus.
- On devices without hover, the button remains visible.
- The button occupies stable row space even while visually hidden, so revealing it does not shift or truncate content unexpectedly.
- Clicking or keyboard-activating the button never activates the row.
- The button tooltip and accessible label identify the action and project, for example **Remove alpha from Recent Projects**.
- Clicking the button opens removal confirmation directly.
- Choosing **Remove from history** in the Closed-entry dialog transitions in place to the same removal confirmation.
- Every **Cancel** action dismisses the whole dialog. Cancel never acts as Back.
- Confirmed removal affects only Recent Projects history. It does not unregister or close a project, stop sessions or terminals, delete a workspace, or modify files.
- Later meaningful work on a registered project that was removed creates a fresh history entry at the top using the existing record-work path.

## Interaction model

### History rows

A row uses a non-interactive layout container with two sibling interaction targets:

1. A primary row action containing the project name, path, status, and activity indicator.
2. A fixed-size trailing remove button.

The outer container must not retain the current `role="button"` once it contains the remove button; nested interactive controls are invalid. The primary child owns the existing pointer, focus, accessible-name, and keyboard activation behavior. Registered entries select immediately. Closed entries open the decision dialog. The remove button stops event propagation and has its own focus target, tooltip, and accessible name.

The row uses `:hover` and `:focus-within` to reveal the remove button on hover-capable devices. A `@media (hover: none)` rule keeps the button visible for touch and other non-hover input. Hidden presentation must not remove the button from keyboard navigation; opacity and pointer-event styling may hide it visually, while focus reveals it before activation. The control's reserved dimensions prevent layout shift.

### Dialog views

Generalize the current Closed recent-project dialog into one recent-project modal with two views:

- **Closed actions** identifies the Closed entry and offers **Reopen**, **Remove from history**, and **Cancel**.
- **Removal confirmation** identifies the entry, explains the limited effect, and offers **Remove** and **Cancel**.

A Closed-row activation opens the modal in Closed-actions view. A row-end `X` opens it directly in Removal-confirmation view for either registered or Closed entries. Choosing **Remove from history** from Closed actions changes the existing modal to Removal confirmation; it does not stack another modal.

The confirmation copy must state that only the Recent Projects entry will be removed, no project files will be deleted, an open project will remain registered, and future work can add it to Recent Projects again. It must not imply that a Closed directory is missing or that an open project will be closed.

Cancel, Escape, and backdrop dismissal close the entire modal when no operation is running. They do not return from confirmation to Closed actions. Modal actions are disabled while Reopen or Remove is running. While an operation is running, Escape and backdrop clicks are ignored; only the Cancel button is rendered disabled to make this state visible without silently trapping the user.

### Focus behavior

The app records the control that opened the modal:

- Cancel from a Closed-row flow restores focus to that row.
- Cancel from a direct remove flow restores focus to that row's remove button.
- A failed operation keeps the modal open and focus within it.
- After successful removal, the removed control no longer exists. Focus moves to the next remaining history row, otherwise the previous row, otherwise the Recent Projects panel's empty-state focus target.
- If a machine change dismisses the modal, focus is not restored into the old machine's panel.

Focus restoration is best-effort when the panel, entry, or triggering control no longer exists. It must never select a project as a side effect.

## Component and application boundaries

`RecentProjectsPanel` owns row rendering and row-level interaction. Keep `onOpenRegistered` and `onOpenClosed` as-is. `onOpenClosed` continues to supply a focus-restoration closure that returns focus to the row, and `PiWebUiApp` continues to use it to open the Closed-actions view of the new modal. Add a new `onRemoveRequested(entry, cancelFocus: () => void, removalFocus: () => void)` callback triggered exclusively by `X` button clicks. `cancelFocus` returns focus to the originating remove button; `removalFocus` focuses the nearest remaining row after a confirmed removal — next entry's primary action, otherwise previous entry's primary action, otherwise the empty-state element. `PiWebUiApp` calls `cancelFocus` when the user cancels from a direct-remove flow, and `removalFocus` after `RecentProjectController.removeEntry` resolves successfully. The panel does not perform HTTP mutations or own modal state.

The empty-state paragraph must carry `tabindex="-1"` so `removalFocus` can direct focus to it when the list becomes empty after removal.

`PiWebUiApp` owns the active recent-project modal state: entry, selected machine, initial view (`initialView: "closed-actions" | "removal-confirmation"`), generation, cancel-focus closure, and removal-focus closure. Closed-row activation (`onOpenClosed`) opens the modal with `initialView: "closed-actions"` and stores the row's focus-restoration closure as the cancel target. `X` activation (`onRemoveRequested`) opens the modal with `initialView: "removal-confirmation"` and stores the two panel-provided closures for cancel and post-removal focus. It wires Reopen to project registration and removal to `RecentProjectController.removeEntry`. After `removeEntry` resolves successfully the app calls the stored removal-focus closure before clearing modal state. Machine changes dismiss the modal without restoring stale focus, and generation checks prevent an older modal completion from closing or mutating a newer one.

The generalized modal component owns presentation state within one interaction: current view (Closed actions versus removal confirmation), busy state, visible failure, focus containment, and Escape/backdrop handling. It accepts an `initialView: "closed-actions" | "removal-confirmation"` property that the app sets each time it opens the modal, and transitions internally to `"removal-confirmation"` when the user chooses **Remove from history** in Closed-actions view. It receives injected `onReopen`, `onRemove`, and `onClose` callbacks. Escape and backdrop clicks call `onClose` only when no operation is running; they are ignored while busy. This keeps transport and catalog reconciliation outside the Lit component while centralizing confirmation behavior.

Rename the component and its custom element from `ClosedRecentProjectDialog` / `closed-recent-project-dialog` to `RecentProjectDialog` / `recent-project-dialog`. This is an internal rename; no public plugin API changes. Update the `customElements.get("closed-recent-project-dialog")` registration test added in commit `a78620c` to assert `customElements.get("recent-project-dialog")` instead.

## Persistence and server semantics

`DELETE <prefix>/recent-projects/:entryId` removes the identified history entry regardless of whether its canonical path currently matches a registered project. Remove the store's registered-path refusal and the corresponding service-level `409 Recent project is registered` outcome.

The store retains its serialized write boundary and returns the authoritative remaining history list. An unknown entry ID still returns `404`; malformed stored history and persistence failures retain their existing failure behavior.

Removal changes only `recentProjects`. The registered `projects` collection is round-tripped unchanged. Existing sessions, terminals, workspaces, and project files are outside the operation.

The existing touch operation already creates a new history ID when no entry for the registered path exists. Therefore meaningful work after removal naturally recreates the record and moves it to the front. No tombstone, suppression list, or separate restoration operation is introduced.

Concurrent clients follow serialized server order. If a touch is processed after removal, the entry exists again; if removal is processed after a touch, it is absent until later meaningful work. The returned collection from each mutation remains authoritative.

## Client state and concurrency

`RecentProjectController.removeEntry` remains serialized with loads and work-recording for each machine. It clears both latest intent and completed-authority shortcuts before removal, including for registered entries. This is necessary so the next meaningful-work event is not incorrectly skipped as already newest after the server removed the record.

The controller applies the authoritative DELETE response when it still belongs to the selected machine and generation. Registered-entry removal no longer has a conflict outcome or catalog-reconciliation branch because registration is no longer a reason to reject removal. Simplify the `RecentProjectRemovalOutcome` type to `{ kind: "removed" }` only; remove the `{ kind: "registered-conflict"; error: HttpRequestError }` variant and the corresponding `PiWebUiApp` handler that sets an app-level error for it. Ordinary removal failures throw and propagate to the modal, which keeps the entry and displays the specific error.

Stale responses from a previous machine or modal generation cannot replace current history or close the current modal. Removal remains a history operation; it must not call the project-close controller or mutate project navigation state.

## Error behavior

- A failed Remove keeps the confirmation view open, re-enables its actions, and displays the specific error.
- A failed Reopen retains the existing Closed-actions behavior: keep the modal open and display the specific error.
- Cancel after a failure still dismisses the whole modal.
- A `404` removal caused by another client is reported using the existing request error behavior; no optimistic removal is applied without an authoritative response.
- Machine changes dismiss the old modal without restoring stale focus.
- Background record-work failure after a prior removal remains non-blocking, following the existing meaningful-work policy.

## Accessibility and responsive layout

- The row's primary action and remove button are separate keyboard stops with visible focus.
- The remove button uses an `X` icon, not a rounded text control, and has a tooltip plus project-specific accessible label.
- The confirmation is modal, labelled by its heading, traps focus, and starts focus on the non-destructive Cancel action.
- Closed-actions view continues to start focus on Reopen.
- Busy and failure states are announced through appropriate `aria-busy`, status, or alert semantics.
- Long names and paths wrap or truncate within their existing content area without overlapping the fixed action slot.
- Desktop hover/focus behavior and non-hover visibility are verified at narrow and desktop widths.

## Testing

Follow test-driven development and use real DOM interaction for row controls, focus, keyboard behavior, and modal transitions.

### Store, service, and route tests

- Remove a registered history entry while preserving the registered project.
- Remove a Closed history entry.
- Return `404` for an unknown history ID and preserve ordinary persistence failures.
- Remove the obsolete registered-entry `409` contract.
- Touch a still-registered project after removal and verify a fresh history ID at the front.
- Verify local, explicit-local-machine, and federated DELETE behavior remains strict and path segments remain encoded.

### Controller tests

- Apply the authoritative list after registered or Closed removal.
- Clear recency shortcuts so meaningful work immediately after registered-entry removal issues a touch and recreates the entry.
- Preserve per-machine mutation serialization and stale-response suppression.
- Propagate removal failures without changing ready history optimistically.
- Remove obsolete registered-conflict reconciliation coverage.

### Component tests

- Delete or invert the existing `"renders no per-row removal control"` test in `RecentProjectsPanel.test.ts`; it directly asserts the absence of buttons and "Remove" text and will fail immediately under the new design.
- Render a remove button for registered and Closed entries with the expected tooltip and accessible name.
- Keep a stable action slot and verify hover, `:focus-within`, and non-hover visibility rules.
- Prove remove-button pointer and keyboard activation do not trigger registered selection or the Closed decision flow.
- Preserve registered-row direct selection and Closed-row decision behavior.
- Open confirmation directly from either row type.
- Transition from Closed actions to confirmation in place.
- Verify Cancel, Escape, and backdrop dismissal close the whole modal from both views.
- Verify busy states, failure retention, and initial focus in each view.
- Verify focus restoration to the triggering row or button on cancellation, and nearest-row fallback after successful removal.
- Verify machine changes dismiss without stale focus restoration.

### Verification commands

Run focused component, controller, service, store, route, and API tests first. Then run typecheck, lint for changed files, `npm run verify:fast`, and the serial `npm run verify` before merge. Use a Chromium layout probe at desktop and narrow/touch-like viewports to verify visibility, fixed row geometry, focus indication, and absence of overlap.

## Release and documentation

This is a backward-compatible user-facing Recent Projects enhancement and needs a minor Changeset for `@hyperdreamer/pi-webui`. The release note should describe removable open and Closed history entries, confirmation, and automatic reappearance after future work. Do not edit `CHANGELOG.md` manually.

No README or user configuration documentation change is required. The interaction is self-explanatory, changes no configuration, and introduces no operational requirement.

## Scope boundaries

- No permanent exclusion list or "never show again" preference.
- No bulk history selection, bulk removal, clear-all action, Undo, pinning, search, or user-configurable history limit.
- No project unregistration, project-tree close, session or terminal shutdown, workspace deletion, or filesystem deletion.
- No change to what counts as meaningful work.
- No reorder on selection, browsing, assistant output, terminal output, polling, or activity changes.
- No public plugin API, machine federation model, session-daemon protocol, or runtime-ownership change.
