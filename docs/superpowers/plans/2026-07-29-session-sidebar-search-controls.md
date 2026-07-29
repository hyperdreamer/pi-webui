# Sessions Sidebar Search and Cleanup Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline Sessions-sidebar search that finds current and archived sessions, and replace the wide cleanup text button with an accessible broom icon.

**Architecture:** Put the reusable, pure session-row query logic in `src/client/src/sessionSearch.ts`. `SessionList` keeps only local search UI state and chooses normal folded or unfolded-and-filtered projections, while `SessionBrowserDialog` uses the same helper so both views share matching and ancestor-retention semantics. No server, API, daemon, persistence, or routing surface changes.

**Tech Stack:** TypeScript 6, Lit 3 custom elements, Vitest 4, ESLint, npm, Changesets.

## Global Constraints

- Keep search state local and ephemeral; do not add API calls, persisted preferences, URL state, configuration, server routes, or daemon/runtime changes.
- Match queries immediately and case-insensitively against session label, first message, session ID, and workspace path.
- A matching descendant must be discoverable even when its family is normally folded, and its available ancestors must remain visible for context.
- A non-empty sidebar query must show matching archived rows without mutating the user’s stored `archivedExpanded` or session-family expansion state.
- Search controls and the broom control must have descriptive `title` and `aria-label` values; SVGs must be hidden from assistive technology.
- Preserve existing cleanup callback, capability/unavailable messaging, error behavior, session selection, and session-runtime ownership.
- Add a patch Changeset; do not edit `CHANGELOG.md`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/client/src/sessionSearch.ts` | Pure query activation and session-row filtering with ancestor retention. |
| `src/client/src/sessionSearch.test.ts` | Unit coverage for matching fields, blank queries, ancestor retention, cycles, and immutability. |
| `src/client/src/components/SessionBrowserDialog.ts` | Use the shared filter and an unfolded source tree for active queries. |
| `src/client/src/components/SessionBrowserDialog.test.ts` | Prove an initially folded descendant is found in the expanded browser. |
| `src/client/src/components/SessionList.ts` | Add local search UI/state, query-aware projections, archived-result reveal, and broom icon markup/styles. |
| `src/client/src/components/SessionList.test.ts` | Cover sidebar UI wiring, results, archive reveal, action-menu clearing, and cleanup accessibility/callback behavior. |
| `.changeset/sessions-sidebar-search.md` | Patch release note for the user-visible sidebar improvement. |

## Task 1: Create the shared session search projection

**Files:**
- Create: `src/client/src/sessionSearch.ts`
- Create: `src/client/src/sessionSearch.test.ts`

**Interfaces:**
- Produces `hasSessionSearchQuery(query: string): boolean` for consumers deciding whether to build unfolded source rows.
- Produces `filterSessionRows(rows: readonly SessionRow[], query: string): SessionRow[]`, returning matching rows and their available ancestors in the original row order.
- Consumes `SessionRow` from `sessionTreeRows.ts`, `SessionInfo` from `api`, and `sessionLabel()` from `sessionLabels.ts`.

- [ ] **Step 1: Write the failing pure-projection tests**

Create `src/client/src/sessionSearch.test.ts` with a small `row()` fixture and these behavior tests:

```ts
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { filterSessionRows, hasSessionSearchQuery } from "./sessionSearch";
import type { SessionRow } from "./sessionTreeRows";

function row(id: string, patch: Partial<SessionInfo> = {}): SessionRow {
  const session: SessionInfo = {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-07-29T00:00:00.000Z",
    modified: "2026-07-29T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `Message ${id}`,
    ...patch,
  };
  return { session, depth: 0, hasMissingParent: false, external: false, hasChildren: false, folded: false };
}

describe("hasSessionSearchQuery", () => {
  it("treats whitespace-only text as inactive", () => {
    expect(hasSessionSearchQuery("")).toBe(false);
    expect(hasSessionSearchQuery("   ")).toBe(false);
    expect(hasSessionSearchQuery("release")).toBe(true);
  });
});

const matchingCases: [string, string, Partial<SessionInfo>][] = [
  ["label", "release plan", { name: "Release plan" }],
  ["first message", "deploy", { firstMessage: "Deploy the documentation" }],
  ["session ID", "session-42", { id: "session-42" }],
  ["workspace path", "feature-b", { cwd: "/work/feature-b" }],
];

describe("filterSessionRows", () => {
  it.each(matchingCases)("matches a session %s without case sensitivity", (_field, query, patch) => {
    const candidate = row(patch.id ?? "candidate", patch);
    expect(filterSessionRows([candidate], query.toUpperCase())).toEqual([candidate]);
  });

  it("returns a new array for a blank query without changing the input", () => {
    const rows = [row("one"), row("two")];
    const result = filterSessionRows(rows, "  ");
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });

  it("keeps each matching descendant's available ancestors in source order", () => {
    const parent = row("parent", { firstMessage: "Coordinate work" });
    const child = row("child", { firstMessage: "Deploy release", parentSessionPath: parent.session.path });
    expect(filterSessionRows([parent, child], "deploy")).toEqual([parent, child]);
  });

  it("stops safely when malformed parent links form a cycle", () => {
    const first = row("first", { firstMessage: "Needle" });
    const second = row("second", { parentSessionPath: first.session.path });
    first.session.parentSessionPath = second.session.path;
    expect(filterSessionRows([first, second], "needle")).toEqual([first, second]);
  });
});
```

- [ ] **Step 2: Run the new test file and verify the expected failure**

Run:

```bash
npm test -- --run src/client/src/sessionSearch.test.ts
```

Expected: FAIL because `src/client/src/sessionSearch.ts` does not exist yet.

- [ ] **Step 3: Implement the pure projection without mutating rows or sessions**

Create `src/client/src/sessionSearch.ts`:

```ts
import type { SessionInfo } from "./api";
import { sessionLabel } from "./sessionLabels";
import type { SessionRow } from "./sessionTreeRows";

export function hasSessionSearchQuery(query: string): boolean {
  return query.trim() !== "";
}

export function filterSessionRows(rows: readonly SessionRow[], query: string): SessionRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery === "") return [...rows];

  const byPath = new Map(rows.map((row) => [row.session.path, row]));
  const visiblePaths = new Set<string>();
  for (const row of rows) {
    if (!sessionSearchText(row.session).includes(normalizedQuery)) continue;
    let path: string | undefined = row.session.path;
    const seenPaths = new Set<string>();
    while (path !== undefined && !seenPaths.has(path)) {
      seenPaths.add(path);
      const current = byPath.get(path);
      if (current === undefined) break;
      visiblePaths.add(path);
      path = current.session.parentSessionPath;
    }
  }
  return rows.filter((row) => visiblePaths.has(row.session.path));
}

function sessionSearchText(session: SessionInfo): string {
  return [sessionLabel(session), session.firstMessage, session.id, session.cwd].join("\n").toLocaleLowerCase();
}
```

- [ ] **Step 4: Run the helper tests and typecheck**

Run:

```bash
npm test -- --run src/client/src/sessionSearch.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit the independently testable shared projection**

```bash
git add src/client/src/sessionSearch.ts src/client/src/sessionSearch.test.ts
git commit -m "feat(sessions): add shared session search projection"
```

## Task 2: Adopt the shared projection in the expanded Sessions browser

**Files:**
- Modify: `src/client/src/components/SessionBrowserDialog.ts:1-10,79-85,225-247`
- Modify: `src/client/src/components/SessionBrowserDialog.test.ts:62-76`

**Interfaces:**
- Consumes `filterSessionRows()` and `hasSessionSearchQuery()` from `../sessionSearch` created in Task 1.
- Consumes `sessionRowsForCurrentTree()` from `../sessionTreeRows` when a query is active.
- Preserves the existing `SessionBrowserDialog` public properties and callbacks; it only changes the source rows supplied to the shared query helper.

- [ ] **Step 1: Add a failing folded-descendant browser regression test**

Add this test to `SessionBrowserDialog.test.ts`:

```ts
it("finds a matching child even when its session family starts folded", () => {
  const parent = session("parent", { firstMessage: "Coordinate release" });
  const child = session("child", { firstMessage: "Deploy the documentation", parentSessionPath: parent.path });
  const dialog = new SessionBrowserDialog();
  dialog.sessions = [parent, child];
  Reflect.set(dialog, "searchQuery", "deploy");

  const renderedText = templateText(dialog.render());
  expect(renderedText).toContain("Coordinate release");
  expect(renderedText).toContain("Deploy the documentation");
});
```

- [ ] **Step 2: Run the browser test and verify the expected failure**

Run:

```bash
npm test -- --run src/client/src/components/SessionBrowserDialog.test.ts
```

Expected: FAIL in the new test because the current folded row projection omits the child before filtering.

- [ ] **Step 3: Switch active browser searches to the shared helper and an unfolded source tree**

In `SessionBrowserDialog.ts`:

1. Add these imports and keep the existing normal-state `sessionRowsForSessionList` import:

```ts
import { filterSessionRows, hasSessionSearchQuery } from "../sessionSearch";
import { sessionRowsForCurrentTree, type SessionRow } from "../sessionTreeRows";
```

2. Replace `visibleRows` with the following implementation:

```ts
private get visibleRows(): SessionRow[] {
  const rows = hasSessionSearchQuery(this.searchQuery)
    ? sessionRowsForCurrentTree(this.sessions)
    : sessionRowsForSessionList(this.sessions, {
      expandedSessionPaths: this.expandedSessionPaths,
      ...(this.selected === undefined ? {} : { selectedSessionPath: this.selected.path }),
    });
  return filterSessionRows(rows, this.searchQuery);
}
```

3. Delete the local `filterSessionRows()` and `sessionSearchText()` functions at the bottom of the component. The shared module is now the single source of search behavior.

- [ ] **Step 4: Run focused tests and lint the changed component**

Run:

```bash
npm test -- --run src/client/src/sessionSearch.test.ts src/client/src/components/SessionBrowserDialog.test.ts
npx eslint src/client/src/components/SessionBrowserDialog.ts src/client/src/sessionSearch.ts
```

Expected: all focused tests and ESLint pass.

- [ ] **Step 5: Commit the expanded-browser behavior change**

```bash
git add src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionBrowserDialog.test.ts
git commit -m "fix(sessions): search folded browser descendants"
```

## Task 3: Add Sessions-sidebar search and the compact broom control

**Files:**
- Modify: `src/client/src/components/SessionList.ts:1-12,69-77,121-190,222-224,243-251,612-654,675-681`
- Modify: `src/client/src/components/SessionList.test.ts:1-10,66-85,367`

**Interfaces:**
- Consumes `filterSessionRows()` and `hasSessionSearchQuery()` from `../sessionSearch`.
- Preserves `SessionList` public properties and `onCleanup`, `onOpenExpanded`, selection, and archive callbacks.
- Adds only private `searchOpen`, `searchQuery`, and `searchInput` state/element references plus private search render/interaction methods.

- [ ] **Step 1: Add failing sidebar behavior tests**

Extend the test-support import in `SessionList.test.ts` with `findOptionalTemplateEventHandlerNearMarker`, then add this focused suite. The direct template-handler calls are proportionate here because Vitest runs in the Node environment without a DOM harness; each lookup is anchored to stable user-facing ARIA or input-ID markup and asserts component state or supplied-callback behavior.

```ts
describe("session sidebar search and cleanup controls", () => {
  it("opens and closes the inline search control, clearing its query on close", () => {
    const list = new SessionList();
    const openSearch = findOptionalTemplateEventHandlerNearMarker(list.render(), 'aria-controls="session-search"');
    expect(openSearch).toBeTypeOf("function");
    if (openSearch === undefined) throw new Error("Expected session search control");

    openSearch(new Event("click"));
    expect(templateText(list.render())).toContain('id="session-search"');
    Reflect.set(list, "searchQuery", "release");

    const closeSearch = findOptionalTemplateEventHandlerNearMarker(list.render(), 'aria-controls="session-search"');
    expect(closeSearch).toBeTypeOf("function");
    if (closeSearch === undefined) throw new Error("Expected session search close control");
    closeSearch(new Event("click"));

    expect(Reflect.get(list, "searchQuery")).toBe("");
    expect(templateText(list.render())).not.toContain('id="session-search"');
  });

  it("shows matching folded descendants and archived results while searching", () => {
    const parent = session("parent", { firstMessage: "Coordinate release" });
    const child = session("child", { firstMessage: "Deploy documentation", parentSessionPath: parent.path });
    const archived = session("archived", {
      archived: true,
      archivedAt: "2026-07-29T00:00:00.000Z",
      firstMessage: "Deploy archived notes",
    });
    const list = new SessionList();
    list.sessions = [parent, child, archived];
    Reflect.set(list, "searchQuery", "deploy");

    const renderedText = templateText(list.render());
    expect(renderedText).toContain("Coordinate release");
    expect(renderedText).toContain("Deploy documentation");
    expect(renderedText).toContain("Deploy archived notes");
    expect(renderedText).toContain("▾ Archived");
  });

  it("reports an empty result and clears an obsolete action menu when input changes", () => {
    const list = new SessionList();
    list.sessions = [session("existing")];
    Reflect.set(list, "searchOpen", true);
    Reflect.set(list, "openMenuSessionId", "existing");

    templateEventHandlerAfterMarker(list.render(), 'id="session-search"')(searchInputEvent("missing"));

    expect(Reflect.get(list, "openMenuSessionId")).toBeUndefined();
    expect(templateText(list.render())).toContain("No matching sessions.");
  });

  it("keeps cleanup callable through a labelled icon-only broom button", () => {
    const list = new SessionList();
    list.canCleanup = true;
    const onCleanup = vi.fn();
    list.onCleanup = onCleanup;

    templateEventHandlerAfterValue(list.render(), "Preview session cleanup", "@click")(new Event("click"));

    expect(onCleanup).toHaveBeenCalledOnce();
    expect(templateText(list.render())).toContain("cleanup-icon");
    expect(templateText(list.render())).not.toContain(">Clean up</button>");

    list.canCleanup = false;
    expect(templateText(list.render())).toContain(list.cleanupUnavailableMessage);
  });
});

function searchInputEvent(value: string): Event {
  const event = new Event("input");
  Object.defineProperty(event, "target", { value: { value } });
  return event;
}
```

- [ ] **Step 2: Run the sidebar test file and verify the expected failure**

Run:

```bash
npm test -- --run src/client/src/components/SessionList.test.ts
```

Expected: FAIL because `SessionList` has no search controls, no query-aware projections, and still renders the text cleanup button.

- [ ] **Step 3: Add local search state and query-aware row projection to `SessionList`**

Make these coordinated source changes in `SessionList.ts`:

1. Import `query` from `lit/decorators.js`, import the two functions from `../sessionSearch`, and add local state:

```ts
@query(".session-search-input") private searchInput?: HTMLInputElement;
@state() private searchOpen = false;
@state() private searchQuery = "";
```

2. At the start of `render()`, preserve the current normal folded projection for counters/unread state, build an unfolded source only for search, and keep archived source rows separate from their filtered display rows:

```ts
const sessionTreeSessions = this.sessionTreeSessions();
const treeOptions = this.currentSessionTreeOptions();
const normalCurrentRows = sessionRowsForSessionList(sessionTreeSessions, {
  ...treeOptions,
  expandedSessionPaths: this.expandedSessionPaths,
  ...(this.selected === undefined ? {} : { selectedSessionPath: this.selected.path }),
});
const unfoldedCurrentRows = sessionRowsForCurrentTree(sessionTreeSessions, treeOptions);
const currentRowPaths = new Set(unfoldedCurrentRows.map((row) => row.session.path));
const allArchivedRows = sessionRows(this.sessions.filter((session) => session.archived === true && !currentRowPaths.has(session.path)));
const searchActive = hasSessionSearchQuery(this.searchQuery);
const currentRows = searchActive ? filterSessionRows(unfoldedCurrentRows, this.searchQuery) : normalCurrentRows;
const archivedRows = searchActive ? filterSessionRows(allArchivedRows, this.searchQuery) : allArchivedRows;
const currentSelectableSessions = selectableCurrentSessions(currentRows);
const unfilteredCurrentSelectableSessions = selectableCurrentSessions(normalCurrentRows);
const archivedVisible = this.archivedExpanded || (searchActive && archivedRows.length > 0);
```

Use `normalCurrentRows.length + allArchivedRows.length` for the existing header count and `unfilteredCurrentSelectableSessions` for the existing unread count. Use `currentSelectableSessions` for the header/current bulk toolbar, so bulk actions continue to apply to visible current rows. Add this local helper beside `sessionSelectionScope`:

```ts
function selectableCurrentSessions(rows: readonly SessionRow[]): SessionInfo[] {
  return rows
    .filter((row) => !row.external)
    .map((row) => row.session)
    .filter((session) => sessionSelectionScope(session) === "current");
}
```

3. Render `${this.searchOpen ? this.renderSearchInput() : null}` above `.list-body`. Use the filtered `currentRows` and `archivedRows` for groups and rows. Pass `archivedVisible` into `renderArchivedHeading()`, render archive contents when `archivedVisible` is true, and append this empty state when `searchActive` has no result in either source:

```ts
${searchActive && currentRows.length === 0 && archivedRows.length === 0
  ? html`<p class="session-search-empty">No matching sessions.</p>`
  : null}
```

4. Insert `${this.renderSearchButton()}` immediately after the expanded-browser launcher in both `renderHeading()` branches. Add these private methods, mirroring the Projects block’s state transition and focus behavior while using `hasStringValue()` already available in this file for the input boundary:

```ts
private renderSearchButton() {
  if (this.collapsed) return null;
  const label = this.searchOpen ? "Close session search" : "Search sessions";
  return html`
    <button type="button" class="section-search-button" title=${label} aria-label=${label} aria-expanded=${String(this.searchOpen)} aria-controls="session-search" @click=${(event: MouseEvent) => { event.stopPropagation(); this.toggleSessionSearch(); }}>
      ${svg`<svg class="section-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6"></circle><path d="m16 16 4 4"></path></svg>`}
    </button>
  `;
}

private renderSearchInput() {
  return html`<div class="session-search"><input id="session-search" class="session-search-input" type="search" placeholder="Search sessions" aria-label="Search sessions" .value=${this.searchQuery} @input=${(event: Event) => { this.handleSearchInput(event); }}></div>`;
}

private toggleSessionSearch(): void {
  this.searchOpen = !this.searchOpen;
  if (!this.searchOpen) {
    this.searchQuery = "";
    return;
  }
  void this.updateComplete.then(() => {
    if (this.searchOpen) this.searchInput?.focus();
  });
}

private handleSearchInput(event: Event): void {
  if (!hasStringValue(event.target)) return;
  this.searchQuery = event.target.value;
  this.openMenuSessionId = undefined;
}
```

5. Update `renderArchivedHeading` to accept `expanded: boolean`, use that value for the chevron, `aria-expanded`, and conditional archived-selection button, but leave its click handler bound to existing `toggleArchived()`. This gives search temporary visual expansion without changing `archivedExpanded` itself.

6. Replace `renderCleanupButton()` with a labelled icon button while preserving the same callback and title text:

```ts
private renderCleanupButton() {
  const label = this.canCleanup ? "Preview session cleanup" : this.cleanupUnavailableMessage;
  return html`<button type="button" class="cleanup-entry" title=${label} aria-label=${label} @click=${(event: MouseEvent) => { event.stopPropagation(); this.onCleanup?.(); }}>
    ${svg`<svg class="cleanup-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m14 5 5 5"></path><path d="M3 21h6l10-10-5-5L4 16l-1 5Z"></path><path d="m7 17 4 4"></path></svg>`}
  </button>`;
}
```

7. Make `.section-search-button` and `.cleanup-entry` share the existing 30 px icon-control geometry, make `.section-search-icon` and `.cleanup-icon` share the existing outline stroke rules, remove the text-button padding rule from `.cleanup-entry`, and add the Projects-pattern search input/empty-state styles:

```css
.bulk-select-entry, .section-expand-button, .section-search-button, .cleanup-entry { box-sizing: border-box; flex: 0 0 auto; display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; font-size: 13px; line-height: 1; text-transform: none; }
.section-expand-icon, .section-search-icon, .cleanup-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.session-search { flex: 0 0 auto; margin: 0 0 6px; }
.session-search-input { box-sizing: border-box; width: 100%; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 6px 8px; font: inherit; }
.session-search-input:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
.session-search-empty { margin: 6px 0; color: var(--pi-muted); }
```

- [ ] **Step 4: Run focused sidebar/browser/helper tests, typecheck, and lint**

Run:

```bash
npm test -- --run src/client/src/sessionSearch.test.ts src/client/src/components/SessionBrowserDialog.test.ts src/client/src/components/SessionList.test.ts
npm run typecheck
npx eslint src/client/src/sessionSearch.ts src/client/src/components/SessionBrowserDialog.ts src/client/src/components/SessionList.ts
```

Expected: all commands pass. Inspect the compact sidebar at desktop and narrow widths to confirm the three header icons align, the search input does not overflow, visible focus is clear, and matching archive rows appear while search is active.

- [ ] **Step 5: Commit the sidebar behavior and tests**

```bash
git add src/client/src/components/SessionList.ts src/client/src/components/SessionList.test.ts
git commit -m "feat(sessions): add sidebar session search"
```

## Task 4: Add release metadata and run the full verification gate

**Files:**
- Create: `.changeset/sessions-sidebar-search.md`

**Interfaces:**
- Produces a patch Changeset for `@hyperdreamer/pi-webui`.
- Does not change `CHANGELOG.md`; release automation consumes the fragment later.

- [ ] **Step 1: Add the user-facing patch Changeset**

Create `.changeset/sessions-sidebar-search.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add inline session search in the sidebar and a compact broom control for session cleanup.
```

- [ ] **Step 2: Validate the Changeset and full repository state**

Run:

```bash
npm run changelog:status
npm run verify
git diff --check
git status --short
```

Expected: the Changeset is detected, typecheck/lint/Knip/Vitest pass, whitespace validation is clean, and only the new Changeset remains uncommitted before the next step.

- [ ] **Step 3: Commit release metadata**

```bash
git add .changeset/sessions-sidebar-search.md
git commit -m "chore: add sessions search changeset"
```

- [ ] **Step 4: Record the final clean state**

Run:

```bash
git status --short --branch
git log --oneline -4
```

Expected: the feature worktree is clean on `feature/session-sidebar-search-controls`, with the shared projection, expanded-browser adoption, sidebar feature, and Changeset commits visible in history.
