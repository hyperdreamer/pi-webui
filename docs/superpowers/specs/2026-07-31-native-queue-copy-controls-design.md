# Native Pi queue grouping and copy controls — design

**Status:** Approved design direction; awaiting review of this written specification.

## Goal

Make queued work easier to inspect and recover without changing Pi's queue semantics or making PI WEBUI a second queue owner.

PI WEBUI will show Pi's native Steered and Follow-up messages as distinct groups, provide a copy action for each message, and provide a grouped-copy action before the existing destructive clear-all action.

## Constraints and decision

The installed Pi session API exposes read-only Steered and Follow-up message lists plus one `clearQueue()` operation that clears both lists. It does not expose stable queue-entry identifiers or supported operations to remove, restore, replace, reorder, or clear one type independently.

Therefore:

- Pi remains the sole authority for live queue state and delivery timing.
- PI WEBUI does not emulate inactive items, individual removal, restoration, combining, reordering, or per-type clearing.
- The browser renders the latest server status snapshot and performs only clipboard actions or the existing clear-all request.
- PI WEBUI must not mutate Pi private fields or clear and rebuild queues to simulate unsupported behavior.

This deliberately favors a small, reliable feature over a richer but competing queue implementation.

## Accepted user experience

### Live Pi queues

The current flattened live queue list becomes up to two independently rendered groups:

1. **Steered queue**
   - Subtitle: **Sent together at the next turn**.
   - Contains only `kind: "steer"` messages, in the order Pi reports them.
2. **Follow-up queue**
   - Subtitle: **Sent together after the agent finishes**.
   - Contains only `kind: "followUp"` messages, in the order Pi reports them.

Empty groups are omitted. The subtitles are permanently visible secondary text, not tooltip-only information, because a group represents Pi's delivery timing rather than a promise that every row produces a separate agent response.

The existing client-local **Queued until session starts** section remains separate. It is a transient delivery backlog, not a live Pi queue, and is not split into Steered and Follow-up groups.

### Copy one message

Every visible queued message receives an accessible, non-destructive **Copy** control:

- It copies that message's exact displayed text to the clipboard.
- It does not alter queue state, ordering, delivery, or pending counts.
- It is available for messages in the two live Pi groups and the client-local startup section.
- It uses the established client clipboard boundary and existing button styling/patterns where applicable.
- A clipboard failure leaves the queue unchanged and is handled through the application's existing browser-error behavior.

### Copy all queues and clear all queues

When **both** live Pi queue types are non-empty, show the shared actions in this order:

1. **Copy all queues**
2. **Clear all queues**

`Copy all queues` is explicit: clearing must never silently overwrite the user's clipboard. It copies the live Pi queues only, not the client-local startup backlog.

The copied plain text preserves group identity and rendered order:

```text
Steered queue
<first steered message>

<second steered message>

Follow-up queue
<first follow-up message>
```

Use blank lines between messages and between groups. This produces a useful record while keeping the two Pi delivery modes distinguishable.

`Clear all queues` continues to call Pi's supported global clear operation. It is shown only when both live groups exist, so the label accurately describes its scope. When only one live group exists, individual Copy controls remain available but no unsupported per-queue clear control is implied.

### Explicit non-goals

This change does **not** add:

- Combine messages;
- individual Remove, Undo, Restore, or inactive/dimmed queue entries;
- per-type Clear actions;
- queue reordering or editing;
- client-side shadow state for live Pi messages;
- a new server route, session-daemon protocol, or persistence model; or
- a change to when or how Pi delivers Steered and Follow-up messages.

## Architecture and data flow

`SessionStatus.queuedMessages` remains the live data contract. The existing server projection continues to expose Pi's message text and `kind`; no server or shared API type changes are needed.

A focused client-side presentation helper derives the display model from the latest snapshot:

- preserve the current client-local startup section as its own section;
- partition live messages by `kind` into Steered and Follow-up sections;
- omit empty sections; and
- expose a small, pure formatter for `Copy all queues` text.

`ChatView` remains a thin rendering and event-wiring boundary. It receives the already-authoritative queue snapshot, renders sections and controls, and delegates clipboard writes to the existing clipboard helper. It must not cache or optimistically mutate live queue contents.

The existing global clear handler remains the only queue mutation path. Its normal status refresh/event update determines the post-clear rendering.

This is a client/UI-only change. It does not alter `src/server/sessiond.ts`, session runtime ownership, the session-daemon protocol, or Pi session behavior. The usual UI/API development-service autoreload path is sufficient; no manual `pi-webui-sessiond.service` restart is needed.

## Accessibility and interaction details

- Every icon-only Copy control has a specific accessible name, such as `Copy steered message 1`.
- Shared controls have explicit labels: `Copy all queues` and `Clear all queues`.
- Group headings and subtitles remain readable without relying on color, hover, or a tooltip.
- Copy buttons are ordinary buttons with keyboard activation and do not interfere with selecting or reading formatted message content.
- Clipboard operations never prevent a status update or alter the clear action's availability.

## Testing and verification

Follow the repository testing guide, preferring the smallest useful seam.

1. **Pure presentation-helper tests** cover:
   - no live groups for an empty status;
   - separation of Steered and Follow-up messages;
   - order preservation within each group;
   - retention of the separate client-local startup section; and
   - copy-all text with headings, blank-line separators, and no startup messages.
2. **ChatView component tests** cover:
   - group headings and permanent timing subtitles;
   - individual Copy controls and their accessible labels;
   - shared Copy all / Clear all ordering and visibility only when both live groups are non-empty;
   - invocation of the established clipboard boundary for individual and aggregate copying; and
   - preservation of the existing clear-all callback behavior.
3. Do not add server/session-daemon tests for this UI-only behavior; existing status serialization remains unchanged.
4. Run the focused ChatView test file first, then `npm run typecheck`, lint changed TypeScript files, `npm run build`, `git diff --check`, and the repository's broader verification required for the implementation change.

## Documentation and release impact

The controls are discoverable in the chat UI, so no README or end-user documentation expansion is required for this focused change.

When implementation begins, add one patch Changeset for the user-visible queue inspection/copy improvement. Do not edit `CHANGELOG.md` manually.

## Expected implementation areas

- `src/client/src/components/ChatView.ts`: queue-section presentation, copy controls, aggregate-copy action, and rendering.
- `src/client/src/components/ChatView.test.ts`: focused presentation and interaction coverage.
- Existing client clipboard helper/imports: reuse rather than add a new browser-URL or server boundary.
- `.changeset/`: one patch Changeset when the feature implementation is added.
