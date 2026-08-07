# Project directory hierarchy - design

## Goal

Make related project directories as easy to scan as parent and child Sessions.
When more than one registered project lies on the same directory path, show the
nearest registered ancestor as the parent and allow each project family to be
expanded or collapsed in both the Projects sidebar and the expanded Projects
browser.

The hierarchy is a client-side presentation of the existing flat project
catalog. It does not change what a project owns, how projects are selected, or
how projects are stored.

## Accepted behavior

### Directory relationships

- A project is a child of the deepest registered project whose canonical path
  is a strict directory ancestor of its path.
- Path matching uses directory boundaries. `/work/app` is not an ancestor of
  `/work/application`.
- Hierarchies may have arbitrary depth. Given registered projects at `dir1`,
  `dir1/dir2`, and `dir1/dir2/dir3`, the resulting depths are zero, one, and
  two.
- A missing intermediate project does not break the family. If `dir1/dir2` is
  not registered, `dir1/dir2/dir3` becomes a direct child of `dir1`.
- Adding an intermediate project adopts its nearest descendants on the next
  catalog projection. Closing an intermediate project moves its descendants to
  the nearest remaining ancestor, or to the root when no ancestor remains.
- Relationships are inferred only among projects in the current machine's
  catalog. Paths from different machines are never compared.

Project paths are canonicalized by the existing server add flow before they
reach the catalog. The browser projection still recognizes both POSIX `/` and
Windows `\\` directory boundaries so it does not depend on the browser host's
path conventions.

### Expansion and collapse

- Each project with descendants has its own disclosure button.
- Project families start collapsed. A new component instance therefore shows
  each family root and hides its descendants.
- Expanding a project reveals its direct children and any deeper branches whose
  own expansion state was previously retained.
- Collapsing a project hides its complete descendant subtree without clearing
  the remembered expansion state of nested projects.
- Ancestors of the currently selected project are always revealed. This is the
  same visibility guarantee used by Sessions, including when an ancestor would
  otherwise be folded.
- Selected-project disclosure is derived for the current projection and does
  not add ancestor IDs to remembered expansion state. Selecting a different
  project therefore restores the earlier folds where they are no longer needed.
- Expansion state is ephemeral and view-local. The sidebar and expanded browser
  do not synchronize it, and a page reload or newly opened expanded browser
  starts from the default collapsed state.
- Expansion state is keyed by project ID and pruned when projects disappear.

### Ordering

Directory structure takes precedence over pinning. A pinned child remains
under its inferred parent rather than moving to the root.

Each root group and each direct sibling group applies the existing project
ordering independently:

1. pinned projects before unpinned projects;
2. projects with an existing activity indicator before idle projects within
   each pin cohort;
3. project registry order as the stable final tie-breaker.

The existing activity calculation remains authoritative. Because it recognizes
activity under a project's directory, an ancestor may continue to signal
activity while a descendant row is hidden. Pin state does not propagate from a
descendant to its ancestors.

Rows are emitted in pre-order: a project appears immediately before its visible
descendants. Ordering never mutates the incoming project catalog.

### Search

Search remains immediate, local, case-insensitive, and matched against project
name and full path.

While a query is active:

- fold state is temporarily ignored;
- every matching project is shown with its complete registered ancestor chain;
- unrelated descendants and unrelated branches remain hidden;
- disclosure buttons are hidden because search determines visibility.

Clearing the query restores the exact expansion state that existed before
search. Search does not add or remove project IDs from that state.

### Family presentation

Both project views use the existing Sessions family-frame visual language.

- One theme-aware frame surrounds a root project and all of its currently
  visible descendants.
- A root that owns descendants keeps the frame when collapsed, so the row still
  reads as a family root.
- Nested projects do not create nested frames. Their disclosure controls,
  indentation, and tree markers communicate deeper levels inside the one root
  frame.
- A project with no descendants remains an ordinary unframed row.
- Descendant rows use indentation and a `↳` marker consistent with Sessions.
- Visual indentation is capped at two steps, matching Sessions, so names,
  paths, activity indicators, and action menus remain usable in the narrow
  sidebar. The logical depth is not capped, and the complete path remains
  available.

The frame uses existing semantic theme colors rather than a hardcoded red or
other literal color.

## Architecture

### Shared tree projection

Extend the existing project list projection boundary with a project-tree row:

```ts
interface ProjectTreeRow {
  project: Project;
  depth: number;
  hasChildren: boolean;
  folded: boolean;
}
```

The pure projection accepts the flat project catalog, query text, selected
project ID, expanded project IDs, workspaces by project, and activity state. It
owns five deterministic steps:

1. infer the nearest registered parent for every project;
2. build child groups independent of catalog order;
3. order roots and each child group with the existing pin/activity/source rules;
4. derive normal fold visibility or search visibility;
5. flatten the visible hierarchy into immutable `ProjectTreeRow` values.

Nearest-parent inference chooses the longest strict ancestor path. A
proportionate pairwise scan is sufficient for the small user-managed project
catalog and keeps the path contract easy to review and test. Strict ancestry
cannot create a cycle because every parent path is shorter than its child path;
the traversal may still guard against duplicate or malformed input rather than
recurse indefinitely.

`hasChildren` describes the complete catalog relationship, not only the rows
visible under the current query. Components can therefore retain the family
frame and accurate disclosure semantics when a family is folded.

The existing flat filtering and ordering helpers may be retained as small
internal operations where they clarify the implementation, but both project
views consume the tree projection as their display source. No Lit component is
imported merely to obtain domain logic.

### Component ownership

`ProjectList` owns only sidebar presentation state and interaction:

- `expandedProjectIds`;
- existing query and action-menu state;
- disclosure event handling;
- grouping projected rows into root family frames;
- rendering compact paths and capped indentation.

`ProjectBrowserDialog` owns the equivalent ephemeral expansion state for its
component lifetime. It uses the same projected rows while retaining its full
path wrapping, modal focus behavior, actions, and responsive layout.

Rendering stays local to each component because the compact and expanded rows
have different markup and layout constraints. The deterministic tree logic is
shared; a new shared Lit row abstraction is not needed.

Each component groups a projected row sequence at depth-zero boundaries. A
group receives a family frame when its root has children, even if folding or
search leaves only the root visible. There is never a family frame inside
another family frame.

Disclosure controls follow the existing Session control contract:

- `aria-expanded` reflects the effective fold state;
- the accessible label is `Expand <project name>` or
  `Collapse <project name>`;
- pointer activation stops propagation so it does not select the project;
- the control uses the established Session-sized hit target and visible focus
  treatment.

Project rows retain their existing pointer and keyboard selection behavior.
No `role="tree"` contract is introduced because rows contain independent action
controls and the requested behavior matches the existing Sessions disclosure
pattern rather than a new composite tree widget.

### Data flow

```text
flat projects + workspaces + activity
                  +
 query + selected ID + expanded project IDs
                  |
                  v
       shared project-tree projection
                  |
                  v
         ordered visible row groups
                  |
          +-------+-------+
          |               |
          v               v
 ProjectList       ProjectBrowserDialog
```

Add, close, pin, unpin, selection, and activity updates continue through the
existing controllers and callbacks. Their updated inputs cause Lit to request a
new pure projection. The hierarchy introduces no controller command or side
effect.

No project API, shared API type, server route, project registry format,
configuration key, app-shell state, URL, or session-daemon behavior changes.

## Reconciliation and error handling

The hierarchy itself performs no I/O and has no asynchronous failure path.

- A path with no strict registered ancestor remains a root.
- Equal paths are not a parent-child relationship. The server already prevents
  duplicate registered paths during normal adds.
- Paths on different roots or drives remain separate roots.
- When the catalog changes, components remove IDs that no longer exist from
  their expansion sets.
- If a catalog or activity update moves or hides the row whose action menu is
  open, the component closes that stale menu before another action can run.
- If the selected project is absent, no ancestor receives forced disclosure.
- Existing controller and application error handling remains responsible for a
  failed add, close, pin, unpin, selection, or statistics action.

There is no fallback write, persistence migration, or user-visible hierarchy
error state.

## Verification

Implementation follows red-green-refactor, beginning with the pure projection.

### Projection tests

Add focused tests for:

1. direct parent-child inference;
2. arbitrary-depth nearest-parent inference;
3. ancestry independent of input order;
4. missing and removed intermediate projects;
5. strict path boundaries such as `/work/app` and `/work/application`;
6. separate roots or drives and Windows separator handling;
7. root and sibling pin/activity/source ordering;
8. a pinned child remaining under its parent;
9. default folding and explicit expansion;
10. retained nested expansion after an ancestor is collapsed and reopened;
11. forced disclosure of every selected-project ancestor;
12. search matches with ancestor context and no unrelated branches;
13. search leaving expansion state unchanged;
14. input immutability and traversal safety.

### Component tests

Extend focused `ProjectList` and `ProjectBrowserDialog` coverage for:

- family frames around roots with children and no nested frames;
- ordinary unframed standalone rows;
- depth, indentation, and descendant markers;
- disclosure labels and `aria-expanded` state;
- disclosure activation changing local state without selecting the row;
- independent sidebar and dialog expansion state;
- selected-descendant visibility;
- search suppressing disclosure controls while showing contextual rows;
- catalog reconciliation of expansion and action-menu state;
- unchanged selection, pin, activity, statistics, close, modal, and keyboard
  behavior.

Use a real DOM/custom-element interaction where proportionate. If the current
Node harness cannot render the relevant Lit boundary without disproportionate
setup, use the repository's existing narrow TemplateResult handler extraction
helpers, anchored to stable accessible labels and asserting observable state or
callback effects.

### Final checks

Run the narrow project projection and component Vitest files first, followed by
typecheck, lint for changed client files, and `npm run verify` on an otherwise
idle machine. Capture desktop and narrow browser screenshots of both project
views with a multi-level fixture and inspect family frames, disclosure targets,
path wrapping, capped indentation, action-menu space, and text overlap.

The shipped feature is user-visible and receives a patch Changeset. Do not edit
`CHANGELOG.md` directly.

## Scope boundaries

This feature does not add:

- persisted or synchronized fold state;
- manually assigned project parents;
- drag-and-drop project hierarchy changes;
- hierarchy-aware project ownership or filesystem operations;
- project renaming or path moving;
- a new API or storage relationship;
- changes to Workspaces or Sessions hierarchy behavior;
- session-daemon changes.

## Alternatives rejected

### Server-derived parent IDs

Adding an ephemeral `parentProjectId` to project API responses would centralize
inference but change a shared contract for a relationship the existing client
catalog can derive deterministically. UI fold and search state would still be a
client concern.

### Persisted parent relationships

Storing project parent IDs would permit manual grouping but introduce stale
links, migrations, and conflict resolution when projects are added or closed.
It would also make stored metadata compete with the requested directory-based
source of truth.

### Separate component-local tree implementations

Inferring and filtering the tree independently in each project view would keep
each edit superficially local but allow ordering, search, and edge-case behavior
to diverge. A shared pure projection is the smallest boundary that guarantees
both views show the same hierarchy.
