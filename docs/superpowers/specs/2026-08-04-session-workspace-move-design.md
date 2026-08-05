# Move eligible user-created sessions between workspaces - design

**Status:** proposed
**Date:** 2026-08-04 (rewritten against `v1.11.0`)

## Summary

Let a user move an eligible PI WEBUI session from one workspace to another
workspace in the same registered project on the same machine. The move preserves
the conversation, name, model policy, pin, order, unread and notification state,
and the browser prompt draft, and it changes where the agent's tools actually
operate.

Eligibility is deliberately narrow. Only a session that PI WEBUI created as a
browser root through the Sessions `+` flow can move, and only while nothing it
has ever done makes relocation unsafe. Any shell invocation, any write inside the
workspace, any unknown tool, any workspace attachment write, and any tracked
child permanently forbids the move for that session forever.

## What changed since the previous revision

The previous revision of this design was written against `v1.11.0-beta.8`. The
following repository facts changed and invalidated parts of it.

**Durable browser-root provenance already exists.** `v1.11.0` added
`src/server/sessions/sessionCreationSource.ts`, which persists
`creationSource: "session-list-plus"` as a `pi-webui.session-creation-source`
custom entry inside the session transcript. Version 2 of that entry binds an
`origin: { sessionId, sessionFile }`, and
`inspectSessionCreationRootEligibility()` rejects a parented transcript, a
missing origin, a mismatched session id, and a mismatched session file. The
previous revision proposed building this provenance from scratch in a new store
and explicitly kept move provenance separate from the `session-list-plus`
marker. That separation is now obsolete: the marker is the provenance.

**The origin binds an absolute session file path.** Session directories are
derived from the workspace cwd. `sessionDirInDefaultPiStore()` encodes the cwd
into a directory name such as `--data-home-guest-Development-pi-webui--`, so
moving a session between workspaces physically relocates its `.jsonl` file. That
relocation invalidates `origin.sessionFile`, and an invalid origin makes the
session ineligible as a root, which would silently break
`rememberCurrentModelPolicy` after a move. The migration must therefore rebind
the origin, and this design does that with a newest-wins appended entry rather
than a file format change.

**More state is keyed by identity than the previous revision accounted for.**
`SessionMetadataStore` and `SessionArchiveStore` are keyed by session file path,
while `SessionUnreadStore` and `SessionNotificationStore` are keyed by a
`{ sessionId, cwd }` identity. A move changes both kinds of key, so the
transaction has a wider surface than "rewrite the header cwd".

**The release is no longer a prerelease.** The version moved from
`v1.11.0-beta.8` to `v1.11.0`, so this ships as a minor Changeset.

The core decisions of the previous revision survive: a true cwd move rather than
visual regrouping, permanent one-way disqualification, fail-closed policy
handling, server-side authority, and a journaled recoverable transaction.

## Problem

A user picks a workspace before they know what the work needs. They start a
session in the project root, describe a task, and only then realize the work
belongs in a worktree. Today the session is stuck. Its cwd is persisted in the
transcript header and determines the session directory, so the only recovery is
to abandon the conversation and retype it somewhere else.

That loss is unnecessary for the specific case where PI WEBUI itself created the
session moments earlier and the agent has not yet touched the filesystem. In
that state the conversation is portable: nothing in it depends on the old
workspace path.

The reason this cannot be offered generally is that PI WEBUI cannot prove
portability for an arbitrary session. A CLI session, an imported session, a
spawned or forked session, or any pre-feature session has no record of whether
its agent already wrote files, ran commands, or created children in the old
workspace. Moving such a session would silently relocate an agent whose prior
work assumed a different tree.

## Goals

- Move an eligible browser-root session to another workspace in the same project
  on the same machine.
- Change the real runtime working directory so future tool calls operate in the
  destination.
- Preserve transcript, name, model policy, pin, order, unread and notification
  state, and prompt draft.
- Keep the session's identity stable when it is already persisted.
- Record one visible, non-user history notice naming source and destination.
- Fail closed: any doubt about safety refuses the move rather than guessing.
- Make disqualification permanent, and never resettable or backfillable.
- Recover deterministically from a crash in the middle of a move.

## Non-goals

- Moving between machines. The move is same-machine only.
- Moving between projects.
- Moving CLI, imported, spawned, forked, cloned, child, archived, or pre-feature
  sessions.
- Backfilling eligibility for sessions that predate this feature.
- Resetting eligibility after disqualification.
- Rewriting transcript content, tool history, or prior file paths mentioned in
  the conversation.
- Moving a whole session family or a session with tracked children.
- A public plugin API for declaring a tool read-only.

## Domain model

### Browser-root session

A browser-root session is a top-level session PI WEBUI created through the
Sessions `+` flow or the equivalent empty-workspace composer flow, recorded by
the existing durable creation-source entry with a version 2 origin bound to that
session's own id and file, and with no `parentSession` in its header.

This is exactly what `inspectSessionCreationRootEligibility()` already decides.
This design consumes that decision rather than reimplementing it.

### Move identity

A move identity is the canonical pair `{ sessionId, cwd }`, where `cwd` is
normalized with the existing `canonicalizeStoredCwd()`. This matches the
identity convention `SessionUnreadStore` and `SessionNotificationStore` already
use, so the same key shape can address every store the move touches.

Resolution must find exactly one session for an identity. Duplicate matches and
prefix-only matches fail closed with `ambiguous-source`.

### Permanent disqualification

Separate from provenance, each identity may carry a durable forbidden marker.
The marker is one-way: it records the first reason and its timestamp and is never
cleared.

```ts
type SessionMoveForbiddenReason =
  | "shell"
  | "workspace-write"
  | "unclassifiable-write-target"
  | "unknown-tool"
  | "unknown-extension-command"
  | "workspace-attachment"
  | "tracked-subsession";
```

Provenance lives in the transcript. The forbidden marker is genuinely new state
and needs its own durable store, because it must survive a restart, must be
writable before the disqualifying action runs, and must not depend on parsing
tool history back out of the transcript.

### Live movability

A session is movable right now when all of the following hold:

- resolution finds exactly one session for the exact `{ sessionId, cwd }`
  identity;
- the session is a current, non-archived browser root by the existing
  root-eligibility check;
- no forbidden marker exists for the identity;
- the session is authoritative-idle, with no in-flight turn, queued prompts, or
  policy transition;
- the session has no tracked children and no active parent link;
- the destination is a different workspace in the same project on the same
  machine; and
- the forbidden-marker store is readable, so absence of a marker is proven
  rather than assumed.

### Read-only allowlist

Only a code-reviewed, server-owned classifier decides that an operation is
read-only enough to preserve eligibility. Version one allowlists PI WEBUI-owned
and Pi built-in read operations by name. Everything else, including every
third-party plugin tool, is treated as unknown and permanently forbids the move.

`bash` and any direct shell invocation always forbid the move, including a
harmless command such as `git status`. This is intentional: PI WEBUI cannot prove
what a shell command did, and a cheap conservative rule is easier to trust than a
command parser.

A `write` or `edit` whose target resolves inside the workspace forbids the move.
If the target cannot be classified with confidence, that also forbids the move.

### Workspace target

A destination is valid when it is a known workspace of the same project on the
same machine, it exists on disk, it differs from the source, and it does not
already contain a session with the moving session's id.

### Invariants

1. A session that is not a proven browser root never moves.
2. A forbidden marker, once written, is permanent.
3. A disqualifying action never runs before its marker is durably persisted.
4. Provenance stays valid after a move, so a moved session remains a root.
5. The session id is preserved for a persisted source.
6. No move begins unless the session is authoritative-idle.
7. Every move is journaled before it mutates anything.
8. A failed move leaves exactly one usable session.
9. Repeated moves are allowed while eligibility remains intact.

## Shared contracts

### Capability

Add `sessionsMove` with wire value `sessions.move` to `PI_WEBUI_CAPABILITIES` in
`src/shared/apiTypes.ts`, and register it in the `web` and `sessiond` runtime
lists and the requirement map in `src/shared/capabilities.ts`, following
`sessionsReorder`. Register the route in `src/shared/federatedRoutes.ts` beside
the other `/sessions/:sessionId/...` mutations so a selected remote machine
proxies it.

Older peers simply do not advertise the capability, and the browser then hides
the action.

### Policy projection

`SessionInfo` gains an optional projection so the browser can render the action
without a second request.

```ts
type SessionMoveProjection =
  | { state: "eligible" }
  | { state: "forbidden"; reason: SessionMoveForbiddenReason };
```

The field is omitted for every session that is not a browser root, which keeps
the common listing payload unchanged. Archived sessions suppress the projection
while retaining the underlying marker, so a restore does not resurrect
eligibility that was already lost.

### Move request and response

```
POST api/.../sessions/:sessionId/move
```

The request carries the source cwd, the destination cwd, and a client-generated
`operationId` used for retry and crash-recovery idempotency.

The response reports the moved session, and `replacedSessionId` only when an
unpersisted source was replaced by a new id. When present it equals the source
id and tells clients to retire that transient identity.

### Typed conflict reasons

```ts
type SessionMoveConflict =
  | "session-active"
  | "move-permanently-forbidden"
  | "not-browser-root"
  | "ambiguous-source"
  | "has-tracked-subsessions"
  | "archived"
  | "destination-missing"
  | "different-project"
  | "destination-conflict"
  | "policy-unavailable";
```

The transport maps invalid input to `400`, a missing source or destination to
`404`, stale eligibility, stale activity, ambiguous identity, and destination
conflicts to `409`, and unavailable policy persistence to `503`. The browser
presents the typed reason and treats the message as detail.

## Architecture

### SessionMoveEligibilityStore

A focused store owns the durable forbidden markers and the move journal. It is
PI WEBUI-managed state, not user or project configuration, so it lives beside the
existing session stores:

```text
$PI_WEBUI_DATA_DIR/session-move-eligibility.json
```

It follows the conventions already used by `SessionMetadataStore`: a serialized
operation queue, a strict parser that rejects unknown keys, and an atomic
temp-file rename on write.

The document holds, per canonical `{ sessionId, cwd }` identity, an optional
forbidden marker with its reason and timestamp, plus move operation records used
for recovery and idempotency.

```ts
interface SessionMoveEligibilityStore {
  inspect(identity: SessionMoveIdentity): Promise<SessionMoveInspection>;
  forbid(
    identity: SessionMoveIdentity,
    reason: SessionMoveForbiddenReason,
  ): Promise<void>;
  beginMove(intent: SessionMoveIntent): Promise<SessionMoveOperationRecord>;
  advanceMove(operationId: string, phase: SessionMovePhase): Promise<void>;
  completeMove(operationId: string, result: SessionMoveResult): Promise<void>;
  rebind(from: SessionMoveIdentity, to: SessionMoveIdentity): Promise<void>;
  forget(identity: SessionMoveIdentity): Promise<void>;
}
```

`forbid()` is idempotent and keeps the first reason. `rebind()` moves a marker
and its history to the destination identity so a moved session cannot regain
eligibility it had already lost. `forget()` runs only after a session has been
irreversibly deleted.

A corrupt document is never silently overwritten. Because absence of a marker is
what authorizes a move, an unreadable store must never be read as absence; it
fails closed with `policy-unavailable`.

Version one retains completed operation records indefinitely. That keeps
`operationId` retry semantics exact, and any future pruning needs an explicit
format migration that must never drop an incomplete operation.

### SessionMoveGuard

A guard sits in front of tool execution and shell invocation. Before a
potentially disqualifying action runs, it classifies the action and, when the
action is not allowlisted read-only, durably writes the forbidden marker and only
then allows execution.

Ordering is the whole point: marking after execution would leave a window where a
crash loses the marker while the side effect survived.

The guard may skip a durable write only when a successful store read proves the
identity is absent from provenance or already forbidden, because the move is
already impossible. If the store cannot be read, a write-capable action is
refused rather than silently permitted to destroy eligibility invisibly.

### SessionMoveTargetResolver

Resolves and validates the destination against the registered project topology
for the current machine, and rejects same-workspace, missing, cross-project, and
already-occupied destinations. The API exposes no target-machine field, so a
cross-machine move cannot be expressed or proxied.

### SessionMoveMigration

Owns the physical migration for a persisted session:

1. Resolve the destination session directory through the same resolver Pi uses,
   so a configured session directory is honored rather than assumed.
2. Stage a copy of the transcript in the destination directory.
3. Structurally rewrite only the header `cwd`, leaving every other entry byte-
   identical.
4. Append a fresh version 2 creation-source entry whose origin binds the
   destination session file. Because `inspectSessionCreationSource()` scans
   entries newest-first, the rebound origin wins and the session remains a valid
   root. No entry format change is required.
5. Reopen and validate the staged file: header id matches, header cwd is the
   destination, and root eligibility is `eligible`.
6. Migrate path-keyed state, rewriting `SessionMetadataStore` keys from the old
   file path to the new one, preserving pin and order.
7. Migrate identity-keyed state, rebinding `SessionUnreadStore` and
   `SessionNotificationStore` from `{ id, sourceCwd }` to `{ id, destCwd }`.
8. Rebind the eligibility record.
9. Remove the source transcript only after the destination is proven valid.

### SessionMoveService

The server-side orchestrator. It recomputes every eligibility condition under a
per-session exclusive boundary, journals the intent, performs the migration,
republishes state, and emits events. It never trusts a client-supplied
eligibility claim.

### Client move coordinator

Browser-side orchestration lives with the existing session controller logic. It
opens the destination picker, issues the request through the existing
`sessionsApi` boundary with an application-relative path, moves the prompt draft
with the existing `moveDraft(...)` seam, retires a replaced transient id, and
reconciles the sidebar.

## Move transaction

### Common preparation

1. Acquire the per-session exclusive boundary.
2. Verify the capability.
3. Re-read the eligibility store; refuse on unreadable state.
4. Resolve exactly one source session by exact `{ id, cwd }`, rejecting
   archived, unmarked, duplicate, and prefix-only identities.
5. Re-verify root eligibility from the transcript.
6. Re-verify authoritative idleness, empty queue, and no policy transition.
7. Re-verify no tracked children and no active parent link.
8. Validate the destination.
9. Journal the intent with the client `operationId`.
10. Append one visible, non-user notice naming source and destination. It carries
    the operation id for deduplication, is included in later model context, and
    does not trigger an assistant turn.

### Persisted source

Preserve the session id and run `SessionMoveMigration`. The runtime is stopped
before the file is relocated and restarted against the destination, so no live
writer holds the old path.

### Unpersisted source

A transient session has no file to rewrite. Create a replacement in the
destination with a new id, transfer name, model policy, and draft, then stop the
source. Registration for the replacement is internal: it transfers the source
eligibility record instead of registering a second eligible browser root, so a
transient move cannot launder a lost eligibility into a fresh one.

### Projection updates

Republish the affected workspaces, then emit a new `session.moved` event in the
`SessionUiEventBody` union in `src/shared/apiTypes.ts`, carrying the session id,
source cwd, destination cwd, and any `replacedSessionId`. Like `session.created`,
it is a global session event rather than a per-session stream event, because the
browser must update two workspaces. Applying it is idempotent, so a browser may
receive the HTTP response and the event in either order.

## Recovery and idempotency

A repeated request with the same `operationId` returns the original outcome
instead of moving twice. On startup, an incomplete journal entry is completed or
rolled back by inspecting which side actually holds a valid transcript:

- destination valid and source gone: complete;
- destination valid and source present: finish removing the source;
- destination invalid or absent: roll back to the source and discard the staged
  copy.

Because the destination is only trusted after reopening and validating it, a
crash mid-write can never be mistaken for a completed move.

## Concurrency

The per-session boundary serializes a move against prompts, policy writes,
archive, delete, reorder, and another move. A move never runs concurrently with
its own session's turn execution. Two moves of the same session serialize, and
the second re-validates from scratch, so it fails cleanly if the first changed
the world.

## Failure behavior

Every failure leaves exactly one usable session.

- **Store unavailable:** refuse with `policy-unavailable`; no mutation.
- **Provenance rebinding fails validation:** roll back; the source stays.
- **Stale dialog state:** refuse with the specific typed conflict.
- **Runtime restart fails at destination:** the transcript is already valid at
  the destination, so recovery completes the move and surfaces a start warning
  rather than resurrecting the old path.
- **Corrupt managed state:** refuse; never rewrite a corrupt document blindly.
- **Remote connection loss:** the operation id makes the retry safe.

## User interface

`Move to workspace...` appears only for a session whose projection says
`eligible`. It stays visible but disabled, with the exact reason, when the
session is active, when the project has no other workspace, and after permanent
disqualification. Keeping it visible and explained is deliberate: a silently
vanishing action would look like a bug.

The destination picker lists only valid workspaces of the current project and
excludes the current one. Success moves the selection with the session when it
was selected, and updates the sidebar in place when it was not.

## Security and path handling

Destination paths are validated against registered project topology and the
existing path-access rules rather than accepted from the client as free-form
paths. Client paths stay application-relative through the existing request
boundary, and every dynamic segment is encoded. The move performs no network
transmission of transcript content beyond the existing federation proxy.

## Verification strategy

Unit tests cover the classifier, the identity canonicalization, the eligibility
store including corruption and idempotent `forbid()`, and target validation.

Integration tests cover the guard ordering, that a marker is durably written
before a disqualifying action executes, and that a refused write does not lose
eligibility silently.

Migration tests use a temporary repository and assert that the header cwd is
rewritten, all other entries stay byte-identical, the rebound origin keeps the
session root-eligible, pin and order survive, unread and notification state
follow the new identity, and the source file is gone only after the destination
validates.

Recovery tests kill the transaction at each journal phase and assert
deterministic completion or rollback, plus exact `operationId` replay.

Client tests cover action visibility, disabled reasons, draft transfer, replaced
transient ids, and sidebar reconciliation.

### Verification commands

```bash
npm run typecheck
npm run lint
npm run verify
```

## Operational and release impact

This ships as a minor Changeset against `1.11.0`. It adds one new managed state
file, one capability, one route, and one event. Because the guard and the
migration run inside the session daemon, landing it requires a manual session
daemon restart.

Keep `README.md` unchanged. Document the user-visible eligibility and recovery
behavior in the Sessions section of `docs/faq.html`, and link to a canonical
session-management page instead of duplicating it if one lands first. Migration
internals stay out of user documentation.

## Acceptance criteria

1. An eligible, idle, read-only browser root moves to another workspace in the
   same project, keeps its id and conversation, and its next tool call operates
   in the destination.
2. CLI, imported, spawned, forked, cloned, child, archived, pre-feature,
   duplicate, and prefix-only identities never expose or complete a move.
3. Any shell invocation, workspace write, unclassifiable write target, unknown
   tool, workspace attachment write, or tracked child permanently disables the
   move, and the reason is shown.
4. A moved session is still a valid browser root, so remembering its model policy
   keeps working.
5. Pin, order, unread state, notifications, model policy, name, and draft survive
   the move.
6. A crash at any phase leaves exactly one usable session and resolves
   deterministically on restart.
7. Repeated moves work while eligibility is intact.
8. A peer without `sessions.move` hides the action entirely.
