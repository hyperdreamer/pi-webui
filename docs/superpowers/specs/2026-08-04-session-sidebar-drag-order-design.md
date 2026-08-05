# Persistent session sidebar drag ordering

**Date:** 2026-08-04
**Status:** Approved design

## Summary

Let the user drag the currently selected session in the compact **Sessions**
sidebar to change its durable display order. The order belongs to the
session-owning machine, survives browser and service restarts, and is shared by
browsers connected to that machine.

Reordering changes presentation only. Session parentage, workspace ownership,
archive state, and pin state remain unchanged.

## Problem

The Sessions sidebar currently derives order from Pi's incoming session list,
with pinned sessions projected ahead of unpinned sessions. Users cannot retain a
task-oriented arrangement after a refresh, and linked parent/child sessions make
a naive flat reorder unsafe: moving one rendered row could separate a child from
its family or imply a parent change that did not occur.

The application also exposes the same session hierarchy in an expanded Sessions
browser and can show linked family context from other project workspaces. A
manual order therefore needs explicit sibling boundaries and one machine-owned
source of truth rather than component-local array mutation.

## Goals

1. Let the currently active session be reordered with a mouse or touch pointer
   from an explicit grip in the compact Sessions sidebar.
2. Persist order on the selected machine and return it through the existing
   session catalog contract.
3. Preserve parent/child hierarchy: a root moves with its complete rendered
   family, while a child moves only among children of the same parent.
4. Keep pinned sessions above unpinned sessions and prevent a drag from changing
   pin state.
5. Put newly created sessions at the top of their eligible unpinned group.
6. Reflect persisted order in normal sidebar and expanded-browser projections.
7. Remain compatible with older web processes, session daemons, clients, and
   metadata files.

## Non-goals

- Reparenting or detaching sessions through drag and drop.
- Reordering archived sessions or search results.
- Dragging in the expanded Sessions browser.
- Reordering an unselected or external context row.
- Moving a session across a pinned/unpinned boundary.
- Keyboard reordering in the first version.
- Browser-local or workspace-config persistence.
- Live cross-browser order events. Other browsers observe the winning order on
  their next catalog refresh or browser-resume refresh.
- Cleaning all metadata left by permanently deleted sessions.

## Domain model

### Active selection

"Selected session" means `AppState.selectedSession`, not a checkbox selected by
the sidebar's bulk-selection mode. Only that active row can expose a grip.

### Reorder scope

A **reorder scope** identifies sessions that may be compared by manual position:

- A root scope contains root sessions whose `parentSessionPath` is absent and
  whose canonical `cwd` is the same.
- A child scope contains sessions whose exact `parentSessionPath` is the same.

The selected project's known workspace catalog bounds which cross-workspace
children participate in one request. A sibling outside that catalog is not
visible or reordered by the operation.

### Eligible group

An **eligible group** is one reorder scope split by current pin state. Every
member is persisted, unarchived, and represented in the current project catalog.
Pinned and unpinned groups never mix.

The client submits the complete eligible group in proposed order. A group with
fewer than two sessions has no useful move and exposes no grip.

### Family movement

For a root session, the persisted position belongs only to the root. Its visible
descendants remain attached during projection, so dragging the root moves the
whole rendered family frame.

For a child session, only direct siblings in the same eligible group are valid
drop peers. Descendants remain attached to the moved child, and no lineage field
is changed.

### Manual position

`SessionInfo` gains an optional `manualOrder` non-negative safe integer. It is a
normalized position within one eligible group, not a global rank.

The projection applies these rules in order:

1. Partition pinned sessions before unpinned sessions.
2. Within a reorder scope and pin group, put sessions without `manualOrder`
   before sessions with one.
3. Preserve incoming order among sessions without `manualOrder`.
4. Sort positioned sessions by ascending `manualOrder`.
5. Preserve incoming order as the deterministic tie-breaker for duplicate
   positions from legacy or externally edited metadata.

An unpositioned new session therefore appears at the top. The first successful
reorder of its group assigns normalized positions to every current member.

Root sessions from different workspaces are not compared by `manualOrder`.
Projection first partitions all roots into pinned and unpinned cohorts, preserving
the existing global pin-first behavior. Inside each pin cohort it groups roots by
canonical workspace in first-seen order and applies manual order only within each
workspace group. Child arrays already share one exact parent and are ordered
directly within that scope.

## Architecture and ownership

### Session daemon

The session daemon is the authoritative owner of manual order. `PiSessionService`
validates a reorder against current session files, archive records, project
catalog workspaces, parent links, pin metadata, and persistence state. It then
asks `SessionMetadataStore` to apply one normalized group update.

This is a session-daemon protocol change. After implementation, operators must
manually restart `pi-webui-sessiond.service`; restarting only the autoreloading
web/UI service is insufficient.

### Metadata store

The existing `$PI_WEBUI_DATA_DIR/session-metadata.json` remains the sole durable
file for pin and order metadata. Its per-session-path entry evolves additively:

```ts
type SessionOrderScopeMetadata =
  | { kind: "root"; cwd: string }
  | { kind: "children"; parentSessionPath: string };

interface SessionOrderMetadata {
  position: number;
  scope: SessionOrderScopeMetadata;
  pinned: boolean;
}

interface SessionMetadata {
  pinned?: boolean;
  order?: SessionOrderMetadata;
}
```

The store exposes one snapshot read for list enrichment and one serialized batch
operation that:

1. reads the file inside the existing exclusive queue;
2. verifies that every submitted entry still has the expected pin state, treating
   absent `pinned` as false;
3. assigns one submitted scope/pin signature and `position` values `0..n-1` to
   the submitted paths;
4. preserves each entry's pin field and every unrelated entry;
5. writes through the existing temporary-file-and-rename path.

Missing `order` remains valid. A present order must have one valid scope, an
explicit boolean pin state, and a non-negative safe-integer position. Invalid
stored values fail strict metadata parsing rather than creating an unstable
display order.

List enrichment exposes `manualOrder` only when the stored order's scope and pin
signature still match the session's current canonical CWD/parent and effective
pin state. This prevents a stale or racing metadata write from applying an old
position in a different group.

Pin, unpin, and parent-detach metadata operations clear the affected session's
`order`. Archiving and restoring preserve it. Permanent deletion may leave a
harmless stale entry, matching current pin-metadata behavior.

### Pure projection

`sessionTreeRows` remains the pure owner of tree ordering. It receives session
records containing optional `manualOrder`, constructs root and child groups, and
applies pin-first/manual-order comparison without mutating parent relationships.
Both `SessionList` and `SessionBrowserDialog` consume this projection, so the two
views cannot drift.

### Sidebar component

`SessionList` owns only ephemeral pointer state: pending pointer, active drag,
candidate slot, pointer capture, and edge-scroll animation. It computes a
proposed order from already-projected rows and emits an async callback containing
the target session, reorder scope, project catalog CWDs, and ordered session
references. It does not write persistence or own authoritative order.

### Controller and application shell

`SessionController` owns mutation orchestration. It applies optimistic positions
to `AppState.sessions`, `AppState.projectSessions`, and `selectedSession`, invokes
the API, merges the authoritative response, and restores/refreshes after failure.
Only one client-side reorder mutation may be in flight.

`PiWebUiApp` and `AppNavigationPanel` provide the selected-machine capability,
project catalog, callback wiring, and current sessions to `SessionList` using the
same direction as existing pin/unpin actions.

## Shared contracts

Add the capability:

```ts
sessionsReorder: "sessions.reorder"
```

It is advertised only when both the web process and session daemon support the
contract. The sidebar does not render a grip when the selected machine lacks the
capability.

The additive shared API contracts are:

```ts
type SessionReorderScope =
  | { kind: "root"; cwd: string }
  | { kind: "children"; parentSessionPath: string };

interface SessionReorderRequest {
  cwd: string;
  scope: SessionReorderScope;
  pinned: boolean;
  catalogCwds: string[];
  orderedSessions: SessionRef[];
}

interface SessionOrderEntry extends SessionRef {
  manualOrder: number;
}

interface SessionReorderResponse {
  orderedSessions: SessionOrderEntry[];
}
```

`cwd` resolves the target session named in the URL. `catalogCwds` is the unique,
canonical set of known workspaces for the selected project. Every
`orderedSessions` entry has required `id` and `cwd` fields so custom session
directories and remote machines never fall back to an ambiguous id-only lookup.

The browser calls:

```text
POST api/machines/:machineId/sessions/:sessionId/reorder
```

The application reference remains relative, every dynamic URL segment is
encoded by the existing session path helper, and the JSON body carries CWDs and
other structured values.

The request parser rejects unknown object properties and enforces existing
session-id/CWD/path string bounds. `catalogCwds` and `orderedSessions` must each
be non-empty, contain no duplicates, and contain no more than 1,000 entries.

## Server validation

The route parses structure and bounds, normalizes every CWD, and delegates domain
validation to `PiSessionService`. The service acquires group mutation
coordination for every submitted session, then validates the request against one
metadata snapshot and current session/archive listings:

1. The URL target resolves to a current, persisted, unarchived session.
2. The ordered group contains that exact target identity once.
3. Every submitted reference resolves to a current, persisted, unarchived
   session in a submitted catalog CWD.
4. The submitted `scope` still matches the target's current parent/root state.
5. Every ordered member belongs to that scope.
6. Every member's current pin state equals submitted `pinned`.
7. The submitted identities equal the complete eligible group found in the
   submitted project catalog.

Validation completes before the metadata batch starts. The metadata batch
rechecks expected pin state inside its own exclusive queue. Archive and
parent-detach paths use the same per-session mutation coordination, so they
cannot change a submitted member between service validation and the write. A
session created after validation remains unpositioned and appears first by the
normal new-session rule. The normalized response contains the submitted
identities in accepted order with positions `0..n-1`.

The route maps failures deliberately:

- `400` for malformed data, unsupported properties, duplicate references,
  invalid bounds, omission of the URL target, or references outside the declared
  catalog;
- `404` when the target or another reference no longer exists;
- `409` when resolved current records do not match the submitted scope, pin,
  archive, persistence, or complete-group signature;
- `500` when durable metadata cannot be read or written.

Typed domain errors distinguish stale conflicts from malformed requests; route
code does not infer status from arbitrary message text.

## Client data flow

### Handle eligibility

The grip is visible only when all of these are true:

- the row is `AppState.selectedSession`;
- the row is local to the current workspace context, current, and unarchived;
- the session is durably persisted;
- the selected machine advertises `sessions.reorder`;
- normal, unfiltered rows are displayed;
- bulk selection and rename are inactive;
- no reorder mutation is pending;
- at least one other eligible peer exists.

Archived rows, search projections, external family-context rows, browser-cached
transient sessions, and rows in `SessionBrowserDialog` never expose the grip.

### Pointer interaction

Use Pointer Events rather than native HTML drag-and-drop so mouse and touch share
one implementation.

1. `pointerdown` on the grip stops row activation and records the origin.
2. Movement at least 6 CSS pixels from the origin starts the drag and captures
   the pointer. Movement below that Euclidean-distance threshold is a no-op.
3. The component derives valid before/after slots only from the selected
   session's eligible group, using each peer's vertical midpoint to choose the
   preceding or following slot.
4. The dragged child row, or complete root family frame, becomes subdued.
5. One insertion line appears at the candidate slot. Invalid groups and pin
   boundaries show no slot.
6. Movement within 32 CSS pixels of the scroll container's top or bottom drives
   one request-animation-frame auto-scroll loop for `.list-body`, proportional
   to edge proximity and capped at 12 CSS pixels per frame.
7. `pointerup` over a valid changed slot emits the proposed complete group.
   Dropping in the original slot performs no mutation.
8. `pointerup` elsewhere, `pointercancel`, Escape, component disconnect, or a
   relevant property/catalog change cancels and cleans up.

The list does not reorder live during pointer movement. Keeping DOM geometry
stable avoids moving the target under the captured pointer.

The grip occupies a reserved `24px` square trailing slot beside the existing
actions menu, so selection does not resize row text. It uses a familiar grip
icon, move cursor, and the tooltip `Drag to reorder selected session`. Only the
grip has `touch-action: none`; the rest of the list retains normal touch
scrolling. The chosen first-version scope intentionally provides no keyboard
reorder behavior, so the grip is not presented as a keyboard-operable button.

### Optimistic mutation

On a valid drop, the controller captures the prior positions and current
machine/workspace sequence, assigns normalized optimistic positions to every
group member in all three relevant state projections, and starts the request.

The response is authoritative. Matching `SessionOrderEntry` values replace the
optimistic values. Identity matching uses machine, canonical CWD, and session id;
path order is never applied to a different machine or workspace scope.

The sidebar rejects another drag until the request settles.

## Related mutation behavior

- **Create:** a new session has no order and appears before positioned peers,
  preserving incoming order among multiple new sessions.
- **Pin:** set `pinned: true` and clear `order`; the session appears first in the
  pinned group.
- **Unpin:** set `pinned: false` and clear `order`; the session appears first in
  the unpinned group.
- **Detach parent:** clear `order` after the parent mutation succeeds; the new
  root appears first in its unpositioned root cohort.
- **Archive:** preserve metadata. Archived sections remain read-only.
- **Restore:** reuse preserved pin and order metadata if the session returns to
  the same scope.
- **Delete archived:** retain the existing best-effort stale metadata policy.

## Concurrency and failure recovery

The metadata store's exclusive queue prevents overlapping writes from corrupting
the JSON file. Scope/pin signatures suppress stale positions, and the pin-state
recheck prevents a reorder from overwriting a concurrent pin transition.
Complete normalized group writes use last-successful-write-wins semantics across
browsers. This low-risk preference does not add revisions, leases, or live order
events.

A drag is canceled before submission if selection, selected machine, workspace,
search state, bulk-selection state, rename state, capability, or the underlying
session catalog changes. This avoids emitting indexes derived from obsolete DOM
rows.

On request failure, the controller:

1. restores captured positions only if the same machine/workspace mutation is
   still current;
2. reports the error through the existing application error surface;
3. refreshes the current workspace and project session catalogs.

The refresh is required even after rollback because a response can be lost after
the daemon committed. A late completion from an old machine/workspace sequence
cannot patch the newly selected scope.

Pointer cleanup always releases capture when held, cancels the edge-scroll frame,
and clears drag classes and insertion state. Cleanup is idempotent so disconnect
and pointer cancellation can race safely.

## Compatibility

- New client with old daemon: capability intersection omits
  `sessions.reorder`; no grip is rendered and missing `manualOrder` preserves
  existing order.
- Old client with new daemon: additive session fields are ignored, and all
  existing routes continue unchanged.
- Existing metadata file: entries without `order` parse unchanged.
- Mixed web/session-daemon versions: the web process does not advertise the
  capability unless its connected daemon also reports support.
- Remote machines: the federated route forwards the relative path and structured
  body to the selected machine; persistence remains on that machine.

## Testing strategy

Follow TDD and use the smallest layer that proves each contract.

### Pure projection and reorder helpers

Cover:

- pin-first ordering before manual order;
- positioned root and child siblings;
- unordered/new sessions before positioned sessions;
- stable incoming order for unordered items and duplicate positions;
- independent root ordering per canonical workspace;
- root family movement without descendant separation;
- child movement only under the exact parent;
- proposed-order and candidate-slot calculations, including no-op drops.

### Metadata store

Use temporary files to cover:

- old pin-only files;
- strict invalid order position, scope, and pin-signature rejection;
- one normalized batch preserving unrelated metadata and pin fields;
- clearing order through pin/unpin/detach support;
- serialized concurrent batch operations;
- atomic-write failure cleanup.

### Service and routes

Cover successful validation, normalized response, and list enrichment. Reject
empty/oversized arrays, unsupported fields, duplicates, missing target
membership, missing sessions, transient sessions, archived sessions, mixed root
CWDs, mixed parents, mixed pin state, incomplete catalog groups, and stale scope
signatures. Assert each case's deliberate typed `400`/`404`/`409`/`500`
mapping.

Exercise the session-daemon proxy route and capability matrix so local and remote
machines expose the same contract.

### API and controller

Cover application-relative URL construction, dynamic segment encoding, exact
request JSON, strict response parsing, and federated machine routing.

Controller tests cover optimistic updates to `sessions`, `projectSessions`, and
`selectedSession`; one in-flight mutation; authoritative response merge;
rollback plus refresh; ambiguous commit recovery; and stale machine/workspace
completion guards.

### Component interaction

Use a real rendered Lit custom element and synthetic Pointer Events. Direct
`TemplateResult` handler extraction is not appropriate because pointer capture,
DOM targets, cleanup, and visual state are the behavior under test.

Cover grip eligibility, fixed threshold, pointer capture/release, child versus
root-family drag subjects, valid insertion slots, pin/scope rejection, no-op
drops, Escape and pointer cancellation, property-change cancellation, touch
pointer input, and edge-scroll cleanup. Stub geometry and animation frames
deterministically; keep slot calculation in a pure helper.

### Browser verification

Inspect normal and narrow sidebar widths with short and scrollable catalogs.
Verify mouse and emulated-touch movement, edge scrolling, stable row geometry,
the reserved actions/grip area, a clear insertion line, family movement, and no
overlap with labels or the actions menu.

Run focused Vitest files first, then `npm run typecheck`, lint changed files, and
finish with `npm run verify` because the feature crosses shared contracts, client
state, HTTP/session-daemon protocol, persistence, and user-facing UI.

## Documentation and release

The grip is self-discoverable and does not change installation or configuration,
so no README or user-manual expansion is required. Keep this design and the
implementation plan under `docs/superpowers/` as maintainer documentation.

Implementation adds a patch Changeset with user-facing text such as:

> Add persistent drag ordering for selected sessions in the Sessions sidebar.

Do not edit `CHANGELOG.md` during development; the release workflow generates it
from Changesets.

## Alternatives rejected

### Fractional rank per session

Writing only the moved session reduces each mutation, but repeated moves require
precision management and eventual normalization. Concurrent and malformed ranks
also make deterministic recovery harder than one atomic group rewrite.

### Dedicated order ledger

A file of ordered path arrays models groups directly, but duplicates the parser,
exclusive queue, atomic-write, stale-entry, and failure surface already owned by
`SessionMetadataStore`.

### Browser-local order

Local storage avoids protocol work but disagrees across browsers and remote
machine views, and it cannot make the expanded browser share one authoritative
order.

### Native HTML drag-and-drop

Native drag-and-drop matches the existing Activity Rail implementation but does
not provide reliable touch behavior. Pointer Events satisfy the chosen mouse and
touch scope with one contained interaction path.

### Drag every row or reparent on drop

Making all rows draggable increases accidental moves in a dense operational list.
Allowing arbitrary drop locations would either produce a dishonest visual result
or mutate session lineage. The selected-row, same-sibling rule is explicit and
contained.

## Acceptance criteria

1. Only the active, persisted, current local sidebar row exposes a grip when the
   selected machine supports `sessions.reorder` and a valid peer exists.
2. Mouse and touch users can move that session only within its current root/child
   scope and pin group.
3. Dragging a root moves its entire rendered family; dragging a child preserves
   its parent and descendants.
4. Search results, Archived, external context rows, bulk-selection mode, rename
   mode, transient sessions, and the expanded browser are not draggable.
5. The accepted order is stored atomically on the selected machine, survives
   restart, and is reflected by both normal session views after refresh.
6. Pinned sessions remain above unpinned sessions. Pin, unpin, and detach clear
   the affected position without changing unrelated order.
7. New sessions appear before already positioned peers.
8. Invalid or stale requests cannot partially update metadata and return the
   specified `400`, `404`, `409`, or `500` class.
9. Failed or ambiguous client mutations recover from an authoritative catalog
   refresh without applying late results to a different machine/workspace.
10. Old clients, old daemons, and pin-only metadata retain existing behavior.
11. Focused tests, typecheck, lint, browser checks, and `npm run verify` pass.
12. A patch Changeset records the user-visible feature, and `CHANGELOG.md` is not
    edited manually.
