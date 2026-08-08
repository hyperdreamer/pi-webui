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
- The starter composer keeps its existing behavior: it has no session identity, so its attachments stay component-local and are not restored after it is replaced.

## Approach

Use one app-lifetime in-memory attachment draft store. `PiWebUiApp` owns the store and passes the same instance to every `PromptEditor`, including editor instances created after a render-branch change. Store keys use the existing `machineSessionKey(machineId, sessionId)` identity, matching prompt text drafts.

An editor-local map was rejected because a Lit remount would lose every saved draft.

Attachment drafts follow text-draft semantics deliberately: the same `machineSessionKey` identity with `cwd` excluded, the same temporary-to-resolved migration, and the same clear-on-send and clear-on-discard rules. Durability is the single property not matched, and that is a limit rather than a preference. Text drafts are short strings in `localStorage`; one base64-encoded photo is frequently several megabytes against a typical five-megabyte origin quota, and `saveDraft` deliberately swallows quota failures, so an over-quota attachment would vanish silently while appearing saved. In-memory storage fails predictably at reload instead of unpredictably at capture.

## Architecture

### Transient Draft Store

A focused client module owns a map from session key to an attachment draft snapshot. A snapshot contains pending attachment metadata and base64 data plus an optional read error. The store exposes only the operations the editor and session lifecycle need: read a snapshot, write a snapshot, clear a key, move a key, and allocate an attachment ID.

Snapshots are immutable values. The store copies on read and on write, and the editor replaces its rendered array rather than mutating a stored one. An empty snapshot deletes its map entry, so removing or sending the final attachment releases its bytes.

The store allocates attachment IDs. This is load-bearing rather than incidental: today's per-editor counter starts at zero on every mount, so an editor that remounts and restores a snapshot containing `attachment-1` could mint a second `attachment-1` for the next capture. Removal filters by ID, so a duplicate would delete two chips at once. A store-owned monotonic counter keeps IDs unique across remounts and across scopes.

Keys use machine and session ID only, matching prompt text drafts. A session's `cwd` is deliberately excluded so an attachment draft survives a workspace move exactly as its text draft does.

### Prompt Editor Boundary

`PromptEditor` derives its active attachment scope from `machineId` and `sessionId`. When that identity changes, it replaces its rendered attachment state with the new scope's snapshot or an empty draft. Attachment additions, removals, read errors, and composer reset write through to the active store entry.

An attachment capture records its originating scope key before awaiting `FileReader`. On completion it writes the captured files and any read error to that key, and it updates rendered state only while that key is still the active scope. One rule covers both the ordinary case and the late-completion case, so no separate generation counter is required.

The starter composer has no session ID and therefore no scope key. It keeps its current component-local behavior: attachments live only in the rendered state of that editor instance, are consumed by sending, and are discarded when the start screen is replaced. The starter editor is a distinct instance in a distinct render branch, so it can neither read nor write another session's draft.

### Session Lifecycle

`SessionController` receives the narrow move/clear portion of the store through its existing dependency boundary, defaulting to the shared store so existing constructor call sites and tests are unaffected. Wherever it already moves a text draft from a temporary or recreated session ID to a resolved ID, it moves the attachment draft in the same operation. Discarding a transient session clears both draft forms.

This migration prevents a regression that scoping alone would introduce. Once a pending start exists, the composer is scoped to a temporary session ID. When the start resolves, the editor's `sessionId` becomes the real ID, so an unsent attachment draft left under the temporary key would silently disappear from a composer the user never cleared.

No server route, daemon protocol, or durable data model changes.

## Error Handling

A failed file read remains an error on the originating session only. Successful files from the same batch are retained there, preserving the existing partial-success behavior. Switching sessions neither copies nor globally clears that error.

## Consequences

Pending file bytes now survive a session switch for the app's lifetime instead of being dropped. That retention is the fix, but it is also a real cost: a user who attaches large files across many sessions without sending holds all of them in memory until send, reload, or session discard. This is accepted because every entry is releasable by an action the user already has, nothing reaches disk or the network before send, and the previous bounded-memory behavior was the bug being fixed.

## Tests And Verification

Follow the repository TDD cycle, proving each behavior at the narrowest layer that can fail:

1. Store-layer tests (pure, no DOM): per-key isolation, snapshot immutability, empty-snapshot deletion, move, clear, and ID uniqueness across a simulated remount.
2. A `PromptEditor` regression proving A -> B hides A's attachment and B -> A restores it, driven through the component's scope-change lifecycle.
3. A deferred file-read regression proving a read started in A and completed after A -> B updates A only and does not appear in B.
4. Extended pending-session lifecycle coverage proving attachment drafts move from temporary IDs to resolved/recreated IDs and clear when a transient session is discarded.

Component tests follow the existing `PromptEditor` conventions, including the `// @vitest-environment jsdom` pragma where a DOM is required. Run the focused Vitest files, `npm run typecheck`, ESLint on changed files, then `npm run verify:fast`.

The implementation is a user-visible bug fix and receives a patch Changeset. It requires only the web/UI autoreload path; the session daemon does not need a manual restart.

## Non-Goals

- Persisting attachment drafts across page reloads, browser restarts, or devices. Attachment drafts match text-draft scoping, not text-draft durability; see Approach for why.
- Uploading files before the user submits a prompt.
- Changing prompt text persistence.
- Changing attachment delivery modes, size limits, supported MIME types, or server-side attachment handling.
- Adding a draft-management UI or retention settings.
