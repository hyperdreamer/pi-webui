# Session-Scoped Prompt Attachments Design

**Date:** 2026-08-08

## Goal

Keep every unsubmitted prompt attachment with the session where the user added it. Selecting another session must show only that session's pending attachments, and returning to the original session during the same app lifetime must restore its attachment draft.

## Accepted Behavior

- Pending images, generic files, and attachment-read errors are scoped by machine and session ID.
- Switching from session A to session B never renders or sends session A's attachments from session B.
- Returning to session A restores its unsubmitted attachment draft while the current browser app remains open.
- Sending or removing an attachment updates only the selected session's draft.
- Sending clears the selected session's attachment draft.
- Reloading or closing the page forgets attachment drafts. File bytes are never written to `localStorage`, `sessionStorage`, IndexedDB, or server state before submission.
- The attachment delivery choice remains a global user preference; it is not part of a session draft.
- The starter composer cannot inherit attachments from an active session. Its attachments remain transient until submitted or until that unscoped editor is replaced.

## Approach

Use one app-lifetime in-memory attachment draft store. `PiWebUiApp` owns the store and passes the same instance to every `PromptEditor`, including editor instances created after a render-branch change. Store keys use the existing `machineSessionKey(machineId, sessionId)` identity, matching prompt text drafts.

An editor-local map was rejected because a Lit remount would lose every saved draft. Browser persistence was rejected because retaining potentially large or sensitive file contents across reloads is unnecessary for this behavior.

## Architecture

### Transient Draft Store

A focused client module owns a map from session key to an attachment draft snapshot. A snapshot contains pending attachment metadata and base64 data plus an optional read error. The store exposes only the operations the editor and session lifecycle need: read, write, clear, and move.

Reads and writes do not expose the store's mutable arrays. Empty snapshots remove their map entry so removing or sending the final attachment releases its bytes.

### Prompt Editor Boundary

`PromptEditor` derives its active attachment scope from `machineId` and `sessionId`. When that identity changes, it replaces its rendered attachment state with the new scope's snapshot or an empty draft. Attachment additions, removals, read errors, and composer reset write through to the active store entry.

An attachment capture records its originating scope before awaiting `FileReader`. If the read completes after the user selects another session, the result is merged into the originating store entry. It updates rendered state only when that scope is still active. An unscoped starter capture uses an editor generation guard so a stale completion cannot appear after the editor changes context.

### Session Lifecycle

`SessionController` receives the narrow move/clear portion of the store through its existing dependency boundary. Wherever it already moves a text draft from a temporary or recreated session ID to a resolved ID, it moves the attachment draft in the same operation. Discarding a transient session clears both draft forms.

No server route, daemon protocol, or durable data model changes.

## Error Handling

A failed file read remains an error on the originating session only. Successful files from the same batch are retained there, preserving the existing partial-success behavior. Switching sessions neither copies nor globally clears that error.

## Tests And Verification

Follow the repository TDD cycle with focused client tests:

1. Add a `PromptEditor` regression proving A -> B hides A's attachment and B -> A restores it.
2. Add a deferred file-read regression proving a read started in A and completed after A -> B updates A only.
3. Extend pending-session lifecycle coverage to prove attachment drafts move from temporary IDs to resolved/recreated IDs and clear when a transient session is discarded.
4. Run the focused Vitest files, typecheck, lint the changed files, and `npm run verify:fast`.

The implementation is a user-visible bug fix and receives a patch Changeset. It requires only the web/UI autoreload path; the session daemon does not need a manual restart.

## Non-Goals

- Persisting attachment drafts across page reloads, browser restarts, or devices.
- Uploading files before the user submits a prompt.
- Changing prompt text persistence.
- Changing attachment delivery modes, size limits, supported MIME types, or server-side attachment handling.
- Adding a draft-management UI or retention settings.
