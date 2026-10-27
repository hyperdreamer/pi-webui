# SessionList selection reveal — technical specification

Date: 2026-10-27  
Authority: [approved design, revision 2](2026-10-27-session-list-scroll-reveal-design.md)  
Issue: #20

## Scope

Implement the approved selection-reveal rule independently in `src/client/src/components/SessionList.ts`: reveal a rendered selected row only when its session-id-plus-section key differs from the last successfully revealed key, defer a reveal while the row has no layout, and retry an owed reveal on resize or a later update. Preserve the deliberate reveal when selecting, archiving, or restoring an archived session. Implementation deliverables are that component change, `src/client/src/components/SessionList.scroll.test.ts`, and one patch Changeset. Rendering, markup, and CSS stay unchanged.

Not in scope:

- Refactoring `WorkspaceList` or extracting shared reveal logic; the two components retain independent implementations of the same rule.
- Changing `scrollWhenSelected` or its palette consumers (`ActionPalette`, `AutocompleteMenu`, `CommandPicker`).
- Changing which rows are rendered, filtered, grouped, or folded.

## Exact module surface

Add these three plain private fields beside `sessionPointerDrag` and `sessionReorderFrame`, before the document-event callbacks. The two key fields start as `undefined` through normal class-field initialization, matching `WorkspaceList`; neither receives `@state` or `@property`.

```ts
  private visibleSelectedRowKey: string | undefined;
  private pendingRevealRowKey: string | undefined;
  // An enclosing collapsed or compact navigation panel hides this list with CSS, which
  // leaves the rows without layout. Scrolling then is a silent no-op, so the reveal is
  // retried once the list has a size again instead of being consumed while hidden.
  private readonly revealOnResize = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(() => { this.revealPendingSelection(); });
```

Replace the existing `private scrollSelectedIntoView(): void` method with the following two private methods. There is no remaining caller or definition of `scrollSelectedIntoView`.

```ts
  private syncSelectedReveal(): void {
    const rowKey = this.collapsed || this.selected === undefined ? undefined : selectedRowKey(this.selected);
    if (rowKey === undefined) {
      this.visibleSelectedRowKey = undefined;
      this.pendingRevealRowKey = undefined;
      return;
    }
    // Presence first: a row that is not rendered cannot be revealed, and clearing the record
    // here is what lets the row be revealed when it renders again.
    const row = this.renderRoot.querySelector<HTMLElement>(".action-row.selected");
    if (row === null) {
      this.visibleSelectedRowKey = undefined;
      this.pendingRevealRowKey = undefined;
      return;
    }
    if (rowKey === this.visibleSelectedRowKey) return;
    // A row inside a hidden navigation panel has no layout; scrolling it now would do
    // nothing and the reveal would be lost for good, because a parent CSS change does
    // not re-run this component's update cycle.
    if (row.getClientRects().length === 0) {
      this.visibleSelectedRowKey = undefined;
      this.pendingRevealRowKey = rowKey;
      return;
    }
    row.scrollIntoView({ block: "nearest" });
    this.visibleSelectedRowKey = rowKey;
    this.pendingRevealRowKey = undefined;
  }

  private revealPendingSelection(): void {
    if (this.pendingRevealRowKey === undefined) return;
    this.syncSelectedReveal();
  }
```

Add this non-exported module-level helper beside `sessionSelectionScope`:

```ts
function selectedRowKey(session: SessionInfo): string {
  return `${session.id}\u0000${session.archived === true ? "archived" : "current"}`;
}
```

`\u0000` is an escaped NUL in the TypeScript source and becomes the separator at runtime. Preserve that exact construction; object identity, array position, session path, and workspace path are not key inputs. The inspected session fixtures use textual ids such as `"s"`, `"parent"`, and `"child"`, with paths constructed as `/sessions/${id}.jsonl` (`SessionList.test.ts` and `SessionList.crossWorkspace.test.ts` fixture factories). These ids contain no NUL; the separator cannot be confused with ordinary printable id characters or the section suffix. `src/client/src/api.ts` re-exports `SessionInfo`; it supplies no additional id-format rule. This change introduces no id validation or UUID requirement.

### Decision ordering and state ownership

The method body above is the implementation contract: selection/collapse guard → DOM presence → recorded-key comparison → layout check → scroll → record success. The presence query is `querySelector<HTMLElement>(".action-row.selected")`, using the existing class assigned by `renderSession` when `this.selected?.id === session.id`. Do not add attributes or selectors to the row markup.

At each decision-method return, and after an update or resize callback completes, at most one key field is defined:

| Settled state | `visibleSelectedRowKey` | `pendingRevealRowKey` |
| --- | --- | --- |
| No rendered selection to reveal | `undefined` | `undefined` |
| Rendered selection awaiting layout | `undefined` | current row key |
| Selection successfully revealed | current row key | `undefined` |

`syncSelectedReveal` writes both fields to `undefined` for no selection, collapse, or a missing row. On zero rects it clears the visible key and stores the pending key. Only the successful-scroll path assigns a defined visible key, strictly after `scrollIntoView`, then clears the pending key. Those consecutive success assignments may briefly leave both fields defined inside the method; the invariant applies at its return. The archived-expansion branch below only invalidates the visible key. All pending-key writes belong to `syncSelectedReveal`; the retry shim only delegates.

A missing row clears both keys, including a previously successful key. Its later reappearance therefore owes a reveal even when its key has not changed. A present row with a matching successful key returns before `getClientRects`; steady-state updates perform one presence query and no layout measurement or scroll. DOM presence and geometry, rather than duplicated filtering logic, cover `sessions`, `projectSessions`, `currentWorkspacePath`, search, archived visibility, and enclosing CSS visibility.

## `updated()` integration

Keep the existing reorder invalidation, menu/rename cleanup, selection pruning, expansion pruning, collapse cleanup, and `previousSelected` lookup. Make these two edits only within `updated()`.

Current archived-expansion branch:

```ts
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      void this.updateComplete.then(() => { this.scrollSelectedIntoView(); });
      return;
    }
```

Replacement:

```ts
    if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
      this.archivedExpanded = true;
      this.visibleSelectedRowKey = undefined;
    }
```

Current final statement:

```ts
    if ((changed.has("selected") || changed.has("sessions") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();
```

Replacement at the same position:

```ts
    // Refreshes replace session objects without changing the user's selection.
    // Only reveal a newly selected or newly visible row, not every refreshed list.
    this.syncSelectedReveal();
```

Call the decision on every update, including updates to private reactive state. Do not add a changed-property whitelist or an early return before this call. Setting `archivedExpanded` schedules another render. Without search, the selected archived row normally first exists in that follow-up render; with matching active search, `archivedVisible` may already expose it in the current render. Reveal once in the first render where the row exists and has layout. Do not defer through `updateComplete.then`, pre-populate the pending key in the branch, or require exactly two cycles.

## Lifecycle wiring

Add `this.revealOnResize?.observe(this);` immediately after the fifth existing document-listener registration. Add `this.revealOnResize?.disconnect();` immediately after the fifth listener removal, before reorder cancellation. The complete methods become:

```ts
  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocumentClick, true);
    document.addEventListener("pointermove", this.onDocumentPointerMove);
    document.addEventListener("pointerup", this.onDocumentPointerUp);
    document.addEventListener("pointercancel", this.onDocumentPointerCancel);
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.revealOnResize?.observe(this);
  }

  override disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocumentClick, true);
    document.removeEventListener("pointermove", this.onDocumentPointerMove);
    document.removeEventListener("pointerup", this.onDocumentPointerUp);
    document.removeEventListener("pointercancel", this.onDocumentPointerCancel);
    document.removeEventListener("keydown", this.onDocumentKeydown);
    this.revealOnResize?.disconnect();
    this.cancelSessionReorder();
    super.disconnectedCallback();
  }
```

Observe the host, as `WorkspaceList` does. No observer exists when `typeof ResizeObserver === "undefined"`; later Lit updates still retry through the unconditional decision call. Connection and disconnection do not reset the keys.

## Resolved ambiguities

The hidden-panel edge case means a reveal attempted while hidden remains owed until layout returns. A panel hide/show after an already successful reveal does not itself create a new debt: resize callbacks do nothing without a pending key, matching `WorkspaceList`. The retry shim recomputes current selection, collapse, and row presence through the single decision rather than using the cached pending key as a scroll target. Same-instance reparenting after a successful reveal remains unsupported, as the design explicitly states.

## Behavioral acceptance table

`K` denotes the selected session's exact row key; `Kc` and `Ka` are that same id with the `current` and `archived` suffixes. `∅` means `undefined`; pairs are `(visibleSelectedRowKey, pendingRevealRowKey)`. Calls are additional calls for the described transition, not the lifetime total. Every successful call targets the current `.action-row.selected` and uses `{ block: "nearest" }`.

| Input transition | Expected `scrollIntoView` calls | Expected key-field state |
| --- | --- | --- |
| Background refresh after a successful reveal; selection unchanged | `0`; no geometry read | `(K, ∅)` |
| Copied array, replacement objects, or same-id/same-section selected object replacement after success | `0`; no geometry read | `(K, ∅)` |
| Different session selected, its row present with layout | `1` | `(new K, ∅)` |
| Empty list with a selected session → populated with that session | `0` while absent → `1` on appearance | `(∅, ∅)` → `(K, ∅)` |
| Selection cleared → same session reselected with layout | `0` on clear → `1` on reselect | `(∅, ∅)` → `(K, ∅)` |
| List collapsed → expanded with a rendered selection | `0` while collapsed → `1` on expansion | `(∅, ∅)` → `(K, ∅)` |
| Reveal first attempted in a CSS-hidden/compact enclosing panel → layout returns and observer notifies | `0` while hidden → `1` on notification; later refresh `0` | `(∅, K)` → `(K, ∅)` |
| Same hidden attempt without `ResizeObserver` → layout returns → later update | `0` before the update → `1` on the update | `(∅, K)` until update, then `(K, ∅)` |
| Search removes the previously revealed selected row → query cleared | `0` while absent → `1` on reappearance | `(∅, ∅)` → `(K, ∅)` |
| Selected row absent → appears through `projectSessions` alone | `1` on appearance | `(∅, ∅)` → `(K, ∅)` |
| `currentWorkspacePath` alone removes or exposes the selected row | Removal `0`; appearance `1` | Removal `(∅, ∅)`; appearance `(K, ∅)` |
| Selected current session archived while archived section is open | `1`, despite unchanged id | `(Kc, ∅)` → `(Ka, ∅)` |
| Selected archived session restored while archived section is open | `1`, despite unchanged id | `(Ka, ∅)` → `(Kc, ∅)` |
| Selected session becomes archived while archived section is closed | `1` total after automatic expansion; follow-up updates add `0` | If initially absent: `(∅, ∅)` until render, then `(Ka, ∅)`; if search already renders it: `(Ka, ∅)` immediately; no layout instead gives `(∅, Ka)` |
| Selected session absent from both `sessions` and `projectSessions` | `0`; presence loss also clears an old successful or pending record | `(∅, ∅)` |
| Component disconnected | `0` from disconnection or subsequent fake observer notification; observer disconnected | Existing pair unchanged |
| Same instance reparented after a reveal | Unsupported; no reveal guarantee | No connection-time invalidation is added |

Tree folding does not hide the selected row: `sessionRowsForSessionList` unfolds its ancestors and search rows ignore folding. Preserve that behavior without adding a separate folding-trigger rule.

## Test contract

Create `src/client/src/components/SessionList.scroll.test.ts`. Use the reference file's `// @vitest-environment jsdom` header, Vitest imports, mock receiver checks, mutable layout flag, and controllable observer. No API, archive, restore, session-host, or power operation is invoked; archive/restore transitions below are local property replacements.

### Browser-boundary harness

Use the following setup. Snapshot and restore prototype descriptors so existing globals are restored even if the environment supplies an own method. Remove hosts before restoring the observer global, allowing their normal disconnect cleanup to run.

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, Workspace } from "../api";
import { SessionList } from "./SessionList";

const scrollIntoView = vi.fn();
const resizeObservers: FakeResizeObserver[] = [];
// jsdom reports no layout for any element. Model the browser here: a reveal can only run
// while the selected row has layout, which an enclosing hidden panel removes.
let rowHasLayout = true;
const laidOutRects = [new DOMRect(0, 0, 200, 24)];
const getClientRects = vi.fn(() => (rowHasLayout ? laidOutRects : []));
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalGetClientRects = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects");

class FakeResizeObserver implements ResizeObserver {
  private observed = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(): void { this.observed = true; }
  unobserve(): void { this.observed = false; }
  disconnect(): void { this.observed = false; }

  notify(): void {
    if (this.observed) this.callback([], this);
  }
}

function notifyLayout(): void {
  for (const observer of resizeObservers) observer.notify();
}

function restorePrototypeMethod(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
  else Object.defineProperty(HTMLElement.prototype, name, descriptor);
}

beforeEach(() => {
  // jsdom has no layout; observe the browser boundaries instead.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true, value: getClientRects });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  rowHasLayout = true;
  resizeObservers.length = 0;
  scrollIntoView.mockClear();
  getClientRects.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
  restorePrototypeMethod("scrollIntoView", originalScrollIntoView);
  restorePrototypeMethod("getClientRects", originalGetClientRects);
  vi.unstubAllGlobals();
});

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}

function workspace(id: string, path: string): Workspace {
  return { id, projectId: "project", path, label: id, isMain: false, isGitRepo: true, isGitWorktree: true };
}

async function settle(list: SessionList): Promise<void> {
  while (!(await list.updateComplete)) {
    // updated() can schedule another render, including archived expansion.
  }
}

async function mount(
  sessions: SessionInfo[],
  selected?: SessionInfo,
  collapsed = false,
  options: { projectSessions?: SessionInfo[]; currentWorkspacePath?: string; workspaces?: Workspace[] } = {},
): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  if (selected !== undefined) list.selected = selected;
  list.collapsed = collapsed;
  if (options.projectSessions !== undefined) list.projectSessions = options.projectSessions;
  if (options.currentWorkspacePath !== undefined) list.currentWorkspacePath = options.currentWorkspacePath;
  if (options.workspaces !== undefined) list.workspaces = options.workspaces;
  document.body.append(list);
  await settle(list);
  return list;
}

function expectSelectedScroll(list: SessionList): void {
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(scrollIntoView.mock.instances[0]).toBe(list.shadowRoot?.querySelector(".action-row.selected"));
}

async function setSearchQuery(list: SessionList, query: string): Promise<void> {
  if (list.shadowRoot?.querySelector(".session-search-input") === null) {
    const button = list.shadowRoot.querySelector<HTMLButtonElement>(".section-search-button");
    if (button === null) throw new Error("Session search button not rendered");
    button.click();
    await settle(list);
  }
  const input = list.shadowRoot?.querySelector<HTMLInputElement>(".session-search-input");
  if (input === undefined || input === null) throw new Error("Session search input not rendered");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settle(list);
}

async function expandArchived(list: SessionList): Promise<void> {
  const button = list.shadowRoot?.querySelector<HTMLButtonElement>(".subheading .section-toggle");
  if (button === undefined || button === null) throw new Error("Archived section toggle not rendered");
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  await settle(list);
}
```

Use `describe("session selection scrolling", ...)`. Each of the following 13 cases gets fresh fixtures; instantiate only those needed by that case from these declarations:

```ts
const first = session("first", { name: "First session" });
const second = session("second", { name: "Second session" });
const archived = session("archived", { name: "Archived session", archived: true });
const parent = session("parent");
const child = session("child", { cwd: "/other", parentSessionPath: parent.path });
const workspaces = [workspace("main", "/workspace"), workspace("other", "/other")];
```

Unless explicitly overridden, `projectSessions = []`, `currentWorkspacePath = undefined`, `workspaces = []`, `collapsed = false`, `archivedExpanded = false`, search is closed/empty, and `rowHasLayout = true`. `settle` drains scheduled follow-up Lit renders; use it after each property transition, not timers. Every `expectSelectedScroll` includes both the exact options and receiver identity; checking a count alone is insufficient. The snippets below are the required action/assertion bodies; wrap each in an async `it` with the stated case name.

### 1. Initial selection is revealed once

Fixture: two current sessions, selected `first`.

```ts
const list = await mount([first, second], first);
expectSelectedScroll(list);
scrollIntoView.mockClear();
notifyLayout();
expect(scrollIntoView).not.toHaveBeenCalled();
```

### 2. Background refresh and same-id/same-section replacement do not scroll

Fixture: two current sessions, selected `first`; consume the initial successful reveal before refreshing.

```ts
const list = await mount([first, second], first);
expectSelectedScroll(list);
scrollIntoView.mockClear();
getClientRects.mockClear();
list.sessions = [...list.sessions];
await settle(list);
list.sessions = [{ ...first }, { ...second }];
await settle(list);
list.selected = { ...first };
await settle(list);
list.sessions = [second, first, session("third")];
list.selected = { ...first };
await settle(list);
list.statuses = {};
list.activities = {};
list.sending = {};
list.unreadSessionIds = new Set();
await settle(list);
notifyLayout();
expect(scrollIntoView).not.toHaveBeenCalled();
expect(getClientRects).not.toHaveBeenCalled();
```

### 3. A different selected id is revealed

```ts
const list = await mount([first, second], first);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.selected = second;
await settle(list);
expectSelectedScroll(list);
```

### 4. The selected row is revealed on first load and reappearance

Fixture: selected `first`, initially absent from both catalogs. An empty catalog later removes a previously revealed row.

```ts
const list = await mount([], first);
expect(scrollIntoView).not.toHaveBeenCalled();
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
list.sessions = [first];
await settle(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.sessions = [];
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
list.sessions = [{ ...first }];
await settle(list);
expectSelectedScroll(list);
```

### 5. A `projectSessions`-only appearance is revealed

Fixture: current-workspace root `parent`; selected external `child` points to `parent.path`. The child is initially absent. Its later appearance must not involve a `sessions`, `selected`, or workspace-path write.

```ts
const list = await mount([parent], child, false, {
  currentWorkspacePath: "/workspace", projectSessions: [], workspaces,
});
expect(scrollIntoView).not.toHaveBeenCalled();
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
list.projectSessions = [child];
await settle(list);
expectSelectedScroll(list);
expect(list.shadowRoot?.querySelector(".action-row.selected")?.getAttribute("title")).toBe(child.path);
```

### 6. Workspace-path-only appearance reveals; disappearance does not

Fixture: retain exactly the same `sessions`, `projectSessions`, and selected object throughout. `sessionTreeSessions()` excludes the child when its cwd equals `currentWorkspacePath`, and includes it as the root's external descendant in `/workspace`.

```ts
const list = await mount([parent], child, false, {
  currentWorkspacePath: "/other", projectSessions: [child], workspaces,
});
expect(scrollIntoView).not.toHaveBeenCalled();
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
list.currentWorkspacePath = "/workspace";
await settle(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.currentWorkspacePath = "/other";
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
list.currentWorkspacePath = "/workspace";
await settle(list);
expectSelectedScroll(list);
```

### 7. No selection does not scroll; clearing permits the same selection to reveal again

```ts
const list = await mount([first]);
expect(scrollIntoView).not.toHaveBeenCalled();
list.selected = first;
await settle(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
Reflect.set(list, "selected", undefined);
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
list.selected = { ...first };
await settle(list);
expectSelectedScroll(list);
```

### 8. Collapse suppresses reveal; expansion delivers it

Fixture: initially collapsed; replace selection and session objects while collapsed, then repeat collapse/expansion after success.

```ts
const list = await mount([first, second], first, true);
expect(scrollIntoView).not.toHaveBeenCalled();
list.selected = second;
list.sessions = [{ ...first }, { ...second }];
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
list.collapsed = false;
await settle(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.collapsed = true;
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
list.collapsed = false;
await settle(list);
expectSelectedScroll(list);
```

### 9. A hidden reveal is delivered on resize and not repeated on refresh

Fixture: rows remain in the shadow DOM while the mutable layout flag is false. Only the flag and a fake notification expose them; do not trigger a component update to deliver the initial owed reveal. The final phase verifies disconnection with a fresh pending reveal.

```ts
rowHasLayout = false;
const list = await mount([first, second], first);
expect(list.shadowRoot?.querySelector(".action-row.selected")).not.toBeNull();
expect(scrollIntoView).not.toHaveBeenCalled();
notifyLayout();
expect(scrollIntoView).not.toHaveBeenCalled();
rowHasLayout = true;
notifyLayout();
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.sessions = [{ ...first }, { ...second }];
await settle(list);
notifyLayout();
expect(scrollIntoView).not.toHaveBeenCalled();
rowHasLayout = false;
list.selected = second;
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
list.remove();
rowHasLayout = true;
notifyLayout();
expect(scrollIntoView).not.toHaveBeenCalled();
```

### 10. An owed reveal survives without `ResizeObserver`

Fixture: stub the global to `undefined` before constructing the list. Becoming laid out alone supplies no update or notification; a later refresh delivers the reveal.

```ts
vi.stubGlobal("ResizeObserver", undefined);
rowHasLayout = false;
const list = await mount([first], first);
expect(resizeObservers).toHaveLength(0);
expect(scrollIntoView).not.toHaveBeenCalled();
rowHasLayout = true;
expect(scrollIntoView).not.toHaveBeenCalled();
list.sessions = [{ ...first }];
await settle(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.activities = {};
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
```

### 11. Selecting an archived session expands and reveals exactly once

Fixture: `first` current, `archived` archived, initially selected `first`, archived section closed. Also exercise the same selection while matching search already renders the archived row; the expansion must persist after clearing search.

```ts
const list = await mount([first, archived], first);
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.selected = archived;
await settle(list);
expectSelectedScroll(list);
expect(list.shadowRoot?.querySelector(".subheading .section-toggle")?.getAttribute("aria-expanded")).toBe("true");
scrollIntoView.mockClear();
list.sessions = [{ ...first }, { ...archived }];
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
list.remove();

const searched = await mount([first, archived], first);
expectSelectedScroll(searched);
scrollIntoView.mockClear();
await setSearchQuery(searched, "session");
expect(scrollIntoView).not.toHaveBeenCalled();
expect(searched.shadowRoot?.querySelector(".action-row.archived")).not.toBeNull();
searched.selected = archived;
await settle(searched);
expectSelectedScroll(searched);
scrollIntoView.mockClear();
await setSearchQuery(searched, "");
expect(scrollIntoView).not.toHaveBeenCalled();
expect(searched.shadowRoot?.querySelector(".subheading .section-toggle")?.getAttribute("aria-expanded")).toBe("true");
expect(searched.shadowRoot?.querySelector(".action-row.selected")?.getAttribute("title")).toBe(archived.path);
```

### 12. Archiving and restoring the same selected id each reveal the new position once

Fixture: keep the other archived session present throughout so the archived section stays open across both transitions. `first` is a root with no descendants, so archiving moves it into the archived list. Keep its id and path unchanged.

```ts
const list = await mount([first, archived], first);
await expandArchived(list);
expectSelectedScroll(list);
scrollIntoView.mockClear();
const moved = { ...first, archived: true };
list.sessions = [moved, archived];
list.selected = moved;
await settle(list);
expectSelectedScroll(list);
expect(list.shadowRoot?.querySelector(".action-row.selected")?.classList.contains("archived")).toBe(true);
scrollIntoView.mockClear();
list.sessions = [{ ...moved }, { ...archived }];
list.selected = { ...moved };
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
const restored = { ...first, archived: false };
list.sessions = [restored, archived];
list.selected = restored;
await settle(list);
expectSelectedScroll(list);
expect(list.shadowRoot?.querySelector(".action-row.selected")?.classList.contains("archived")).toBe(false);
scrollIntoView.mockClear();
list.sessions = [{ ...restored }, { ...archived }];
list.selected = { ...restored };
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
```

### 13. Search disappearance does not consume the next reveal

Fixture: two named current sessions; select `first`, then search for only `second`. Clear the query without changing selection.

```ts
const list = await mount([first, second], first);
expectSelectedScroll(list);
scrollIntoView.mockClear();
await setSearchQuery(list, "Second session");
expect(list.shadowRoot?.querySelector(".action-row.selected")).toBeNull();
expect(scrollIntoView).not.toHaveBeenCalled();
list.sessions = [{ ...first }, { ...second }];
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
await setSearchQuery(list, "");
expectSelectedScroll(list);
scrollIntoView.mockClear();
list.sessions = [{ ...first }, { ...second }];
await settle(list);
expect(scrollIntoView).not.toHaveBeenCalled();
```

Cases 5 and 6 reject an incomplete changed-property trigger list. Case 12 rejects id-only identity. Cases 4 and 13 reject key comparison before presence checking. Case 9 rejects consuming a reveal while hidden, a resize handler that never delivers it, repeated scrolling after delivery, and notifications surviving disconnection. Check these observable boundaries rather than testing private methods directly.

## Verification commands

After implementation, run these commands from the repository root in the exact order prescribed by the approved design's testing-guide reference. Advance after the preceding command passes; fix failures and rerun the affected check before proceeding.

```sh
npm test -- --run src/client/src/components/SessionList.scroll.test.ts
npm run typecheck
npx eslint src/client/src/components/SessionList.ts src/client/src/components/SessionList.scroll.test.ts
npm run verify:fast
```

Confirm the component diff contains no rendered-template or CSS changes and no `WorkspaceList` or palette changes. The change is confined to the client; no session-daemon code or restart is part of this implementation.

## Changeset fragment

Create exactly one new `.changeset/<slug>.md` fragment for the implementation, for example `.changeset/session-list-scroll-reveal.md`, with this exact patch entry and user-facing sentence:

```md
---
"@hyperdreamer/pi-webui": patch
---

Prevent the session list from jumping back to the selected session during background refreshes while preserving reveals when the selected row appears or moves.
```

Do not edit `CHANGELOG.md` by hand or change the package version. The approved design identifies this client code as part of the published `dist` output, so the fix requires the patch fragment.
