# Expanded project browser — design

## Goal

Make the complete Projects list easy to browse without widening the navigation sidebar or disrupting the current workspace/session layout. A new in-app modal will show every open project with its full path, live filtering, current activity status, and the existing project actions.

## Accepted user experience

- An outline expand icon beside the Projects heading opens an in-app modal titled **Projects**. Its accessible label is **Open expanded project browser**.
- The launcher is available whenever the Projects section is visible, including when that section is collapsed.
- The modal contains a focused **Search projects** field, an Add project action, and the complete project result list.
- Filtering is immediate, case-insensitive, and matches both project name and full path. It is local UI state; no request or persisted preference is introduced.
- Every result renders its full path without ellipsis. Long paths wrap within the result row instead of creating horizontal scrolling.
- Selecting a project closes the modal first, then delegates to the normal project-selection flow. That preserves existing workspace/session navigation and mobile navigation behavior.
- Existing activity indicators and the per-project Close action remain available. Adding a project closes this browser before opening the existing Add project dialog, avoiding stacked modal workflows. Closing a project updates the open modal reactively through the existing project controller.
- Escape, the close icon, and a backdrop click dismiss the modal. On narrow screens, the dialog becomes an edge-to-edge view.

## Architecture

### Component boundary

Introduce a focused `project-browser-dialog` Lit component. It owns only modal presentation and ephemeral interaction state:

- query text;
- search-field initial focus;
- Escape/backdrop/close handling;
- keyboard focus containment and restoration to the launcher;
- rendering result rows, empty states, activity indicators, and row actions.

It receives the current project collection, selected project, workspaces-by-project map, activity map, and callbacks from the app shell. It does not call APIs or own application navigation state.

`ProjectList` remains the compact sidebar component. Its only new responsibility is rendering and forwarding the expanded-browser launcher action. `AppNavigationPanel` forwards that callback to `PiWebUiApp`.

`PiWebUiApp` owns a single reactive `projectBrowserOpen` boolean. It renders the dialog alongside other application overlays, includes it in `isChatObscured()`, and closes it before invoking the same `selectNavigationItem("projects", "workspaces", …)` path used by sidebar selection.

### Shared list projection

Both compact and expanded views must show the same filtered, active-first project order. The existing pure filtering/ordering helpers should move from `ProjectList` into a small presentation helper module rather than having the dialog import a custom-element module or duplicate the logic. The helper accepts projects, query text, workspace ownership, and activity data and returns a new ordered array; it must not mutate application state or the input list.

The action-menu-only ordering helper remains local to `ProjectList` unless the dialog independently needs that behavior.

### Data flow

```text
Projects heading expand button
  → ProjectList.onOpenExpanded
  → AppNavigationPanel.onOpenProjectBrowser
  → PiWebUiApp.projectBrowserOpen = true
  → project-browser-dialog props

search query + current project/activity props
  → shared presentation helper
  → rendered rows

selected row
  → PiWebUiApp.projectBrowserOpen = false
  → existing project selection/navigation flow
```

No server route, API contract, storage format, configuration key, session daemon behavior, or URL route changes.

## Visual and accessibility details

- Use PI WEBUI's existing semantic color tokens, spacing, borders, and outline SVG conventions. The expand glyph represents opening the larger browser, not collapsing the Projects section.
- The desktop dialog is large enough for readable full paths while retaining margins around the overlay; the scrollable list is vertically contained. At the narrow-screen breakpoint it fills the viewport and respects safe-area padding.
- Use `role="dialog"`, `aria-modal="true"`, and a labelled title. The expand and close controls have descriptive accessible labels.
- Focus starts in the search field. Tab navigation stays inside the dialog using the established modal focus-trap pattern, visible focus styles remain intact, and focus returns to the launcher after dismissal.
- Results retain keyboard activation and useful activity semantics. A filtered empty state says **No matching projects.** An empty project collection explains that no projects are open and presents the Add project path.

## Error handling

The browser itself is a synchronous projection over app state and adds no network or persistence failure path.

- If normal selection or project closure reports an error, existing application error handling remains authoritative.
- If a selected or action-menu project disappears due to a reactive update, the component clears stale local menu state rather than acting on it.
- The modal may remain open after a Close action so the user can continue browsing the updated list. It closes only for explicit dismissal, selection, or launching the separate Add project dialog.

## Verification

Follow TDD for the implementation. Add focused tests before production changes that cover:

1. shared projection: case-insensitive name/path filtering, active-first ordering, and immutability;
2. dialog rendering: full path content, filtered empty state, activity indicators, and action availability;
3. dialog interactions: search updates results; selection calls the supplied handler and closes through the app boundary; Escape, backdrop, and close button dismiss it; Add delegates through the existing dialog path;
4. launcher wiring: `ProjectList`, `AppNavigationPanel`, and `PiWebUiApp` forward the expanded-browser callback and mark chat as obscured while open;
5. keyboard/accessibility: labelled icon controls, dialog semantics, initial focus, and focus containment where practical in the existing test harness.

Run the focused Vitest files first, then typecheck, lint the changed client files, and `npm run verify` before review. Capture desktop and narrow viewport screenshots and compare them with the project screenshot-diff workflow to check wrapping, overflow, contrast, and modal sizing.

## Scope boundaries

- This is an expanded list browser, not a project-detail dashboard, separate browser tab/window, or a redesign of workspace/session navigation.
- Do not alter the Projects API, project storage, server routes, session daemon, or project-selection semantics.
- Do not add a global project-search preference, URL routing, virtualization, or speculative metadata.
- The shipped implementation is user-visible and needs a patch Changeset. Do not edit `CHANGELOG.md` directly.
