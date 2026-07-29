# Sessions sidebar search and cleanup control — design

## Goal

Make the compact Sessions sidebar easier to search without taking away space from session rows or changing session-runtime behavior. Replace the wide **Clean up** text control with an accessible broom icon, and add the same inline search-toggle experience used by the Projects block.

## Accepted user experience

- When the Sessions block is expanded, its heading includes a magnifying-glass button beside the existing expanded-browser launcher. It follows the Projects block pattern: clicking it opens an inline, focused `type="search"` field above the list; clicking it again closes the field and clears the query.
- The icon has context-sensitive **Search sessions** / **Close session search** tooltip and accessible-label text, reports its state with `aria-expanded`, and identifies its input with `aria-controls`.
- Search filters both the current session tree and the archived-session area. Matching is immediate, case-insensitive, and covers session label, first message, session ID, and workspace path.
- A query finds a session even when it is a child of a normally folded family. The matching row and its parent path are temporarily shown so tree context remains understandable.
- A query with archived matches temporarily reveals those matches even if the user had left the Archived area collapsed. Closing or clearing the search restores the prior tree-fold and archive-expanded state; searching must not mutate either state.
- If no current or archived session matches, the block renders **No matching sessions.**
- The header's existing **Clean up** button becomes an icon-only broom control. It keeps the existing cleanup-preview callback, capability/unavailable message, and error flow. Its visible-space reduction must not reduce its accessible name: the full cleanup description remains available through `title` and `aria-label`.
- Current session selection, bulk selection, session actions, starting-session display, unread indicators, counters, and the existing expanded Sessions browser otherwise retain their current behavior. Typing a new query dismisses an open row action menu whose anchor may no longer be visible.

## Architecture

### Component boundary

`SessionList` remains the owner of compact-sidebar presentation and introduces only local, ephemeral `searchOpen` and `searchQuery` state. It renders the search button/input, chooses normal or search-result rows, and keeps interaction state local to the custom element. It does not add APIs, persistence, app-shell state, or session-controller responsibilities.

The existing `SessionBrowserDialog` continues to own its dialog presentation and query state. It adopts the same shared search projection so the compact and expanded views cannot diverge in searchable fields, case handling, ancestor retention, or folded-child discovery.

### Shared session search projection

Move the pure query logic currently local to `SessionBrowserDialog` into `src/client/src/sessionSearch.ts`:

- Input: projected `SessionRow` values and query text.
- Output: a new row list containing each matching row and its available ancestors.
- The helper normalizes whitespace/case and constructs searchable text from the agreed label, first message, ID, and workspace path fields.
- It does not mutate source rows, component state, session data, or tree-expansion state. It protects parent traversal from malformed cycles.

Each consumer builds an unfolded source projection while a non-empty query is active before passing it to the helper. This lets search discover descendants hidden by normal family folding. With an empty query, each consumer preserves its existing projection, ordering, and expansion behavior.

### Sidebar data flow

```text
Sessions header search button
  → SessionList.searchOpen
  → focused inline search input
  → SessionList.searchQuery
  → unfolded current/archive SessionRow projections (only while query is non-empty)
  → shared session-search projection
  → current + archived rendered results

Sessions header broom button
  → existing SessionList.onCleanup callback
  → existing cleanup preview/dialog/controller flow
```

For an active query, `SessionList` derives its current bulk-selection toolbar from the displayed current rows, preserving the existing rule that bulk actions apply to visible rows. It renders archived results without requiring a permanent change to `archivedExpanded`. When the query clears, normal current-tree folds and the user's prior archive-expanded choice resume. The session count remains the existing unfiltered session-row count rather than becoming a separate search-result counter.

No server route, API contract, storage format, configuration key, session daemon behavior, or browser URL changes.

## Visual and accessibility details

- Reuse the Projects block's compact, outlined SVG visual language and 30 px icon-control geometry for the session search button. Place it alongside the existing header controls without widening the sidebar.
- Render the search input above the list with the same border, spacing, focus treatment, placeholder, and accessible labeling pattern as the Projects search field.
- Render the broom as an outlined inline SVG within a compact icon button. Keep it visually consistent with the search and expanded-browser icons rather than using an emoji or text glyph.
- **Approved visual refinement:** use a clearly angled broom handle and bristle head with two small outlined four-point sparkle accents above the bristles. The sparkles communicate cleanup while preserving the existing 24×24 view box, 15 px rendered icon size, `currentColor` stroke, and rounded line treatment.
- Use semantic labels rather than relying on SVG meaning alone. The SVGs are hidden from assistive technology; the controls expose descriptive `title` and `aria-label` values.
- Search opening moves focus into the input after Lit updates. The normal section keyboard-navigation and row activation behavior continue to target only the currently visible result rows.

## Error handling

Search is a synchronous, client-only projection over current component properties, so it introduces no network, daemon, storage, or persistence failure path.

- An input event that does not originate from an `HTMLInputElement` is ignored, following existing component conventions.
- Query changes close stale action menus rather than allowing actions to target a row that is no longer rendered.
- The broom button delegates to the existing cleanup flow. Existing capability checks, unavailable messaging, cleanup-preview failures, and user-facing controller errors remain authoritative.

## Verification

Follow TDD for implementation and add focused regression coverage before production changes:

1. **Shared helper tests:** empty query behavior; case-insensitive label, first-message, ID, and workspace-path matches; ancestor retention; hidden-child discovery using unfolded rows; no-match result; input immutability and cycle-safe parent traversal.
2. **Compact `SessionList` tests:** labelled search and broom controls; opening input and focus; close/reset behavior; query filtering across current and archived data; temporary reveal of folded-child and archived matches; no-match state; action-menu dismissal on query changes; unchanged cleanup callback/capability text; and the approved broom-plus-two-sparkles SVG structure.
3. **Expanded browser tests:** the dialog uses the shared matching/ancestor semantics, including a query that finds an initially folded descendant.
4. Run changed Vitest files first, then `npm run typecheck`, lint the changed client files, and `npm run verify` before review. Inspect the UI at normal and narrow sidebar widths for icon alignment, input overflow, visible focus, result context, and archived-result behavior.

The shipped UI change is user-visible and requires a patch Changeset. Do not edit `CHANGELOG.md` directly.

## Scope boundaries

- This is an inline Sessions-block search and compact cleanup control, not a redesign of session navigation, archive lifecycle, bulk selection, or cleanup policy.
- Do not add server-side session search, persistent search history/preferences, URL query state, a global search feature, or a new modal.
- Do not change the expanded browser's scope; it remains project-wide. Its search behavior changes only as needed to share the compact view's accepted matching semantics.
- Do not alter session-runtime ownership, session-daemon protocol, session storage, API contracts, or cleanup execution behavior.
- No README or user-facing documentation update is required for this localized UI polish; the release-facing Changeset will record it after implementation.
- The approved icon refinement changes only the cleanup SVG artwork and its focused regression coverage; it must not alter cleanup behavior, accessible naming, layout geometry, search behavior, or session runtime ownership.
