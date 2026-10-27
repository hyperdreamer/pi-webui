# SessionList selection reveal — design

Date: 2026-10-27
Issue: #20 — "Workspace/session lists re-scroll on background refresh: SessionList still snaps"
Revision: 2 (after frontier design review round 1: 2 blockers, 4 non-blockers, all resolved)

## Background

`WorkspaceList` had the same defect and was repaired in #18, which shipped in 1.28.2. The
repair is the reference implementation for the rule this document applies to `SessionList`.

`SessionList.updated()` still contains:

```ts
if ((changed.has("selected") || changed.has("sessions") || changed.has("collapsed")) && !this.collapsed) this.scrollSelectedIntoView();
```

Every `sessions` replacement therefore reveals the selected row. A background refresh
replaces the session objects without changing the user's selection, so a user who has
scrolled away from the selected row is yanked back to it.

`SessionList` also reveals through a second path: when the selection becomes an archived
session it expands the archived section and scrolls on the next update. Issue #20 records
that path as a deliberate reveal that must be kept.

## Goals

- A background refresh that leaves the selection unchanged must not move the list.
- A selected session that becomes newly visible must still be revealed: newly selected,
  first rendered, list expanded, or an enclosing hidden/compact panel becoming visible.
- Replacing session objects must not be confused with a change that relocates the row.
- The rendered output, markup, and CSS must not change.

## Non-goals

- No refactor of `WorkspaceList`, and no shared extraction of the reveal logic. The two
  components keep independent implementations of the same rule (operator decision,
  option A). `WorkspaceList` is freshly released and verified; re-proving untouched
  behavior is not worth the audit surface for a scroll fix.
- No change to `scrollWhenSelected`, the per-element Lit directive used by the palettes
  (`ActionPalette`, `AutocompleteMenu`, `CommandPicker`). It keys on a selection value per
  element and has no notion of surviving a list refresh, so it does not solve this defect.
- No change to which rows are rendered, filtered, grouped, or folded.

## The rule

Reveal the selected session if and only if the identity of its **rendered row** differs
from the last successfully revealed row identity.

The identity is not the session id alone. It is the session id **plus the section the row
lives in** — the current tree or the archived list:

```ts
function selectedRowKey(session: SessionInfo): string {
  return `${session.id}\u0000${session.archived === true ? "archived" : "current"}`;
}
```

The id alone is insufficient because archiving or restoring the *currently selected*
session keeps the id and replaces the row in a different section
(`sessionController.restoreSession`, and `refreshSessions`' archive-state branch, which
calls `selectSession(refreshed)` for the same id). Today `updated()` reveals in those
cases; an id-only guard would silently stop doing so.

| Condition | Action |
| --- | --- |
| Selected row is not rendered | do not scroll, clear the recorded key (a reveal is owed again later) |
| Row rendered, key equals the recorded key | nothing — no DOM measurement, no scroll |
| Row rendered, key differs, row has layout | scroll, then record the key |
| Row rendered, key differs, row has no layout | do not scroll, record the key as pending for retry |
| No selection, or `collapsed` | clear the recorded and pending keys |

Two properties are inherited from `WorkspaceList` and matter:

1. The key guard decides correctness; the trigger condition is only an early-out. This is
   why the design evaluates on every update instead of enumerating properties.
2. The recorded key is written only after a real scroll. A reveal consumed by a row with
   no layout would otherwise be lost permanently, because a parent CSS change does not
   re-run this component's update cycle.

## Architecture

### State

Three plain private fields on `SessionList`. They are deliberately not `@state`: they are
bookkeeping about the last DOM effect, never render inputs, and making them reactive would
schedule an update from inside `updated()`.

```ts
private visibleSelectedRowKey: string | undefined;   // last successfully revealed row
private pendingRevealRowKey: string | undefined;     // reveal owed, retried on layout
private readonly revealOnResize = /* undefined when ResizeObserver is unavailable */;
```

Invariant: at most one of the two key fields is defined.

### Seams

- `syncSelectedReveal(): void` — the single decision point, called unconditionally from
  `updated()`. Resolves the selected row, applies the presence, key, and layout guards,
  scrolls when the rule requires it, and records the outcome.
- `revealPendingSelection(): void` — the retry entry point used by resize notifications.
  It returns immediately unless a reveal is actually owed, then re-runs the decision.

`connectedCallback` also calls `revealOnResize?.observe(this)`; `disconnectedCallback`
calls `revealOnResize?.disconnect()`, alongside the existing five document listeners that
are added and removed there today.

### The decision, in order

The ordering inside `syncSelectedReveal` is load-bearing and is specified explicitly,
because a plausible-looking variant is wrong and the layout read has to be deferred to keep
it off the hot path:

```ts
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
if (rowKey === this.visibleSelectedRowKey) return;   // already revealed, still rendered
// A rendered row inside a CSS-hidden panel has no layout; scrolling it is a silent no-op.
if (row.getClientRects().length === 0) {
  this.visibleSelectedRowKey = undefined;
  this.pendingRevealRowKey = rowKey;
  return;
}
row.scrollIntoView({ block: "nearest" });
this.visibleSelectedRowKey = rowKey;
this.pendingRevealRowKey = undefined;
```

Row **presence** is tested before the key comparison. Testing the key first would leave
`visibleSelectedRowKey` set when the row stops being rendered — for example when a search
query filters the selection out — so the row's reappearance would match the stale record
and never be revealed. Presence-only resolution is a `querySelector`, which does not force
layout; the geometry read is reached only when the key actually changed or a reveal is
already owed. A steady-state update therefore costs one shadow-root query and no layout
flush.

`pendingRevealRowKey` is set exactly when a row is owed a reveal that could not land, and
is cleared on success, on presence loss, or when the selection clears.

### Row-visibility resolution

The decision resolves presence from the rendered DOM: it queries `.action-row.selected` and
treats a missing row or zero `getClientRects()` as "not visible".

This is the one place where the design deliberately departs from deriving visibility from
data. `SessionList` rows disappear through independent mechanisms — `collapsed`, the
collapsed archived section (`archivedVisible`), search filtering (`filterSessionRows`), and
the workspace filter applied to `projectSessions` — and they can appear through a
`sessions` change, a `projectSessions`-only change (`sessionTreeSessions()` appends
eligible `projectSessions`), or a `currentWorkspacePath` change. Re-deriving all of that in
reveal code would duplicate `render()`'s derivation and could drift from it. A DOM query
plus `getClientRects()` observes the actual outcome at once, and is exactly the signal that
matters: whether a scroll can have an effect.

Tree folding is **not** one of these mechanisms, correcting a claim in revision 1:
`sessionRowsForSessionList` removes the selected session's ancestor paths from the folded
set (`selectedSessionAncestorPaths`), and `sessionRowsForSearch` ignores folded paths
entirely. Folding never hides the selected row.

The hidden-panel case is real and is why the layout check exists: the navigation panel
hides and shows the list with CSS (`AppNavigationPanel` renders `<session-list>` and stays
mounted), so the row element remains in the DOM with zero client rects.

Same-instance reparenting is not a supported path and needs no handling: the panel
hides/shows rather than moving the element. If that ever changes, the recorded key must be
invalidated on `connectedCallback` so the reattached list reveals again.

## Behavior change

`updated()` is otherwise unchanged. Its final line is replaced by an unconditional call:

```ts
this.syncSelectedReveal();
```

The existing early return in the archived-expansion branch is removed, and that branch
keeps its deliberate reveal by clearing the recorded key instead of scrolling:

```ts
if (changed.has("selected") && this.selected?.archived === true && (previousSelected?.id !== this.selected.id || previousSelected.archived !== true) && !this.archivedExpanded) {
  this.archivedExpanded = true;
  this.visibleSelectedRowKey = undefined;
}
```

Setting `archivedExpanded` from false to true schedules a further update cycle, and that
cycle re-renders with the archived section open. The reveal therefore lands on the first
cycle in which the row is actually rendered, exactly once. It is not always the second
cycle: with an active search whose results include archived rows, `archivedVisible` is true
regardless of `archivedExpanded`, so the row may already be rendered in the current cycle
and is revealed there.

Clearing the key rather than setting `pendingRevealRowKey` is deliberate: at the moment the
branch runs the archived section may not have rendered, so presence resolution leaves the
reveal owed on its own. Clearing is the only state the branch has to contribute, keeping a
single owner for the two key fields.

Removing the old `void this.updateComplete.then(...)` callback is a simplification: the
callback could only scroll, it could not survive a hidden panel, and the follow-up cycle it
waited for is guaranteed by the `@state` write.

### Why evaluating on every update is safe

Unrelated updates (statuses, activities, unread sets, reorder state) re-run the decision,
but the recorded key matches, so the function returns after one `querySelector` without
measuring layout or touching scroll position. The only updates that reach `scrollIntoView`
are ones where the selected row is rendered, its key was not successfully revealed, and the
row has layout — exactly the reveal the rule asks for.

`SessionList` has strictly more appearance paths than `WorkspaceList`, so an explicit
property list would already be incomplete today and would silently lose reveals the next
time a row-visibility input is added.

## Edge cases

| Case | Result |
| --- | --- |
| Background refresh, selection unchanged | no scroll — the defect |
| Session objects replaced (copied array or new objects), same id and section | no scroll |
| Different session selected | reveal |
| List empty, then populated with the selected session | reveal |
| Selection cleared, then the same session reselected | reveal |
| Collapsed, then expanded | reveal |
| Enclosing hidden/compact panel hides the rows, then becomes visible | reveal owed at first attempt, delivered by the resize notification |
| `ResizeObserver` unavailable | reveal owed, delivered by any later update |
| Selected session filtered out by the search query | no scroll; cleared, so clearing the query reveals |
| Selected session appears through a `projectSessions`-only change | reveal |
| `currentWorkspacePath` change makes the row stop or start rendering | no scroll, or reveal — whichever the rule gives |
| Session archived while the archived section is open | reveal — the row key changes section, matching today's behavior |
| Session restored while the archived section is open | reveal — likewise, the row moves to the current tree |
| Selected session archived while the archived section is closed | archived section expands and the row is revealed once — the deliberate reveal the issue names |
| Selected session absent from `sessions` and `projectSessions` | row unresolved, no scroll, record cleared |
| Component disconnected | observer disconnected with the host |
| Same element instance reparented after a reveal | not supported; see above |

## Test strategy

A new `src/client/src/components/SessionList.scroll.test.ts`, modeled on
`WorkspaceList.scroll.test.ts`: jsdom, `HTMLElement.prototype.scrollIntoView` stubbed with
a mock, `getClientRects` stubbed to model layout, and a controllable fake `ResizeObserver`.

The issue warns that a `scrollIntoView` call-count spy is not sufficient on its own,
because it cannot detect a reveal consumed while the row has no layout. The suite therefore
asserts both boundaries — the number and target of scroll calls, and the "hidden, then
visible, then refresh" case where a recording-eager implementation would either scroll
spuriously or never scroll again.

Coverage:

1. initial selection is revealed once;
2. background refresh and same-id, same-section selection replacement do not scroll;
3. a different selected id is revealed;
4. the selected row is revealed when the list first loads or reappears;
5. a selected row that appears through a `projectSessions`-only update is revealed;
6. a `currentWorkspacePath` change that makes the row render reveals it, and one that stops
   it rendering does not scroll;
7. no selection means no scroll, and reselecting after a clear reveals;
8. collapsed hides the reveal and expansion delivers it;
9. a reveal owed while the row has no layout is delivered by the resize notification;
10. the owed reveal survives to the next update without `ResizeObserver`;
11. selecting an archived session expands the archived section and reveals it exactly once;
12. archiving and restoring the selected session each reveal its new row position exactly
    once — even though the id is unchanged;
13. a search query that hides the selected row does not consume the reveal, and clearing the
    query reveals the row.

Assertions use `toHaveBeenCalledExactlyOnceWith({ block: "nearest" })` and check that the
scrolled instance is the selected row, so a wrong-target scroll fails rather than passing on
a call count. Cases 5, 6, and 12 exist to fail the implementations this design rejects: a
`changes`-listened variant, and an id-only guard.

Verification order, per the repository testing guide:
`npm test -- --run src/client/src/components/SessionList.scroll.test.ts`, then
`npm run typecheck`, then `npx eslint` on changed files, then `npm run verify:fast`.

## Deliverables

- `src/client/src/components/SessionList.ts` — the guarded reveal.
- `src/client/src/components/SessionList.scroll.test.ts` — new suite.
- `.changeset/<slug>.md` — one patch fragment. `dist` is in `package.json` `files` and
  `src/client` compiles into it, so this is a user-visible fix and `CHANGELOG.md` must not
  be edited by hand.

Expected size: roughly +45 / −6 lines in `SessionList.ts`, approximately 230 lines of test.

## Acceptance

- A background refresh with an unchanged selection leaves the scroll position alone.
- Every path by which the selected row becomes newly visible, or moves, reveals it exactly
  once.
- An owed reveal is never lost to a row with no layout.
- No rendered markup, CSS, or layout change.
- The new suite, typecheck, lint, and `verify:fast` pass.
