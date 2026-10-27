# SessionList Selection Reveal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Keep every task commit green and leave checkboxes unticked; controller state is
> the progress record.

**Goal:** Stop the session list from jumping back to the selected session during a background refresh, while still revealing the selected row whenever it newly appears or moves.

**Architecture:** Replace `SessionList`'s unguarded `updated()` reveal with a single decision function that keys on the selected row's identity — session id plus the section the row renders in — and resolves row presence and layout from the rendered DOM. Record the identity only after a real scroll, and retry a reveal that could not land through a host `ResizeObserver`. The rendered template and CSS are untouched, and `WorkspaceList` is not modified.

**Tech Stack:** TypeScript 6, Lit 3, Vitest with jsdom, Changesets, `tsc --noEmit`, ESLint, `npm run verify:fast`.

## Global Constraints

- Do not modify `WorkspaceList`, `scrollWhenSelected`, or any palette component.
- Do not change rendered markup, CSS, row derivation, filtering, grouping, or folding.
- Do not add runtime dependencies.
- Do not edit `CHANGELOG.md` or the package version by hand.
- The new reveal fields are plain private fields, never `@state` or `@property`.
- Every checkout of the reveal test file uses `// @vitest-environment jsdom`.

## Task 1: Replace the unguarded reveal with the keyed decision

**Implementer tier:** Advanced

**Lane:** `session-list-reveal`

**Files:**
- Modify: `src/client/src/components/SessionList.ts`
- Create: `.changeset/session-list-scroll-reveal.md`

**Interfaces:**
- Consumes: the existing `SessionInfo` type from `../api`, the existing `.action-row.selected` class produced by `renderSession`, and the existing module-level `sessionSelectionScope` function.
- Produces: private members `visibleSelectedRowKey: string | undefined`, `pendingRevealRowKey: string | undefined`, and `revealOnResize: ResizeObserver | undefined`; private methods `syncSelectedReveal(): void` and `revealPendingSelection(): void`; and a non-exported module-level `selectedRowKey(session: SessionInfo): string`. `scrollSelectedIntoView` is removed and has no remaining callers.

**Test commands:**
- `npm run typecheck`
- `npx eslint src/client/src/components/SessionList.ts`

**Checklist:**
- [ ] Add the three plain private fields beside `sessionPointerDrag` and `sessionReorderFrame`. Declare the observer as `private readonly revealOnResize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { this.revealPendingSelection(); });` with the hidden-panel comment from the specification.
- [ ] Delete `private scrollSelectedIntoView(): void` entirely and confirm nothing else references it.
- [ ] Add `private syncSelectedReveal(): void` with the exact body from the specification: selection/collapse guard clearing both fields, `querySelector<HTMLElement>(".action-row.selected")` presence check clearing both fields when null, early return when the computed key equals `visibleSelectedRowKey`, `row.getClientRects().length === 0` branch storing `pendingRevealRowKey` and clearing `visibleSelectedRowKey`, then `row.scrollIntoView({ block: "nearest" })`, then assign `visibleSelectedRowKey` and clear `pendingRevealRowKey`.
- [ ] Add `private revealPendingSelection(): void` returning early unless `pendingRevealRowKey` is defined, otherwise delegating to `syncSelectedReveal()`.
- [ ] Add the non-exported module-level `selectedRowKey` helper beside `sessionSelectionScope`, returning `` `${session.id}\u0000${session.archived === true ? "archived" : "current"}` `` with the literal escape sequence, not a raw NUL byte.
- [ ] In `updated()`, replace the body of the archived-expansion branch so it sets `archivedExpanded = true` then `visibleSelectedRowKey = undefined`, and delete both `void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });` and the branch's `return`.
- [ ] In `updated()`, replace the final `if ((changed.has("selected") || changed.has("sessions") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();` with the two comment lines and `this.syncSelectedReveal();`. Add no changed-property guard before it.
- [ ] Add `this.revealOnResize?.observe(this);` as the last statement of `connectedCallback`, and `this.revealOnResize?.disconnect();` after the fifth `removeEventListener` and before `this.cancelSessionReorder();` in `disconnectedCallback`.
- [ ] Create `.changeset/session-list-scroll-reveal.md` with a `patch` entry for `"@hyperdreamer/pi-webui"` and the user-facing sentence from the specification.
- [ ] Confirm by inspection that no template literal, CSS block, `@state`, or `@property` changed, and that the diff does not touch `WorkspaceList`.
- [ ] Run every command above and require exit 0 before committing.

**Commit message:** `fix(sessions): preserve session list scroll on background refresh`

## Task 2: Add the SessionList scroll reveal suite

**Implementer tier:** Standard

**Lane:** `session-list-reveal`

**Files:**
- Create: `src/client/src/components/SessionList.scroll.test.ts`

**Interfaces:**
- Consumes: the `SessionList` element, its `sessions`, `projectSessions`, `currentWorkspacePath`, `selected`, and `collapsed` properties, and the reveal behavior produced by Task 1.
- Produces: thirteen focused cases covering the specification's behavioral acceptance table, including the refresh-keeps-scroll case and the hidden-panel-then-layout case the issue requires.

**Test commands:**
- `npm test -- --run src/client/src/components/SessionList.scroll.test.ts`
- `npm run typecheck`
- `npx eslint src/client/src/components/SessionList.scroll.test.ts`

**Checklist:**
- [ ] Start the file with `// @vitest-environment jsdom` and import `afterEach`, `beforeEach`, `describe`, `expect`, `it`, `vi` from `vitest`.
- [ ] Build the browser-boundary harness: a `scrollIntoView` mock installed on `HTMLElement.prototype`, a `getClientRects` stub driven by a mutable `rowHasLayout` flag, a `FakeResizeObserver` class that records instances and exposes `notify()`, a `notifyLayout()` helper, and `beforeEach`/`afterEach` that install and remove the prototype overrides. Snapshot and restore the original property descriptors so a pre-existing own descriptor is restored rather than deleted, and clear `document.body` before restoring the observer global so hosts run their disconnect cleanup.
- [ ] Add fixture helpers: a `session(id, overrides)` factory returning a `SessionInfo` with `path` built as `` `/sessions/${id}.jsonl` ``, and a `mount(sessions, selected?, options?)` helper that assigns properties before appending to `document.body` and awaits `updateComplete`.
- [ ] Implement all thirteen cases from the specification: initial reveal; refresh and same-id/same-section replacement silent; different id revealed; first load and reappearance; `projectSessions`-only appearance; `currentWorkspacePath` appearance and disappearance; no selection then reselect; collapse suppresses and expansion delivers; hidden reveal delivered on resize and not repeated on refresh; owed reveal survives without `ResizeObserver`; archived selection expands and reveals exactly once; archive and restore of the same selected id each reveal the new position once; search disappearance does not consume the reveal.
- [ ] Assert the scrolled instance is the selected row, not merely a call count: use `toHaveBeenCalledExactlyOnceWith({ block: "nearest" })` and compare `scrollIntoView.mock.instances[0]` against `list.shadowRoot?.querySelector(".action-row.selected")`.
- [ ] Assert the observation boundary in the two layout cases: with layout absent, require zero calls and a still-owed reveal; after `notifyLayout()`, require exactly one call. In the no-`ResizeObserver` case, stub the global to `undefined` before mounting.
- [ ] Clear the `scrollIntoView` mock between phases inside a case so each phase's expectation describes only that transition.
- [ ] Run every command above and require exit 0 before committing.

**Commit message:** `test(sessions): cover session list selection reveal rule`
