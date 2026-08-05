# Move eligible user-created sessions between workspaces - design

**Date:** 2026-08-04
**Status:** Approved design; awaiting review of this written specification.

## Summary

PI WEBUI will let a narrowly eligible user-created root session move from one
workspace to another workspace in the same registered project on the same
machine.

A move is a real working-directory migration. The session will resume against
the destination workspace; it will not merely appear under a different sidebar
heading. Persisted sessions retain their identity and history. An unpersisted
session is replaced by an equivalent destination runtime and therefore receives
a new session ID.

Move eligibility is intentionally strict. Only browser-root sessions created
after this feature begins recording provenance can qualify. A session remains
eligible only while it is standalone and has never invoked a write-capable or
unclassifiable operation. Any shell or `bash` invocation permanently forbids a
move, including read-only shell commands such as `git status`. Creating a
tracked subsession also permanently forbids a move.

Sessiond owns provenance, permanent disqualification, live idle checks, target
validation, migration, and recovery. The browser only presents server-owned
state and submits a selected destination.

## Problem

Sessions are currently associated with workspaces indirectly through their
persisted `cwd`. Session listing calls are scoped by CWD, the browser groups
sessions by `SessionInfo.cwd`, and Pi's default session directory is derived
from the workspace path. There is no session move route or client action.

Changing only browser state would be unsafe: the sidebar could show a session
under one workspace while its tools continued to execute in another. A true
move must update the session header, account for configured session directories,
rebuild the runtime with destination resources, update CWD-scoped daemon state,
and tell every connected browser that the session changed workspace.

The requested safety policy adds another requirement. A session that has ever
attempted workspace-changing work must never move. Current Git status cannot
attribute a change to one session, and current transcript inspection is not a
sufficient enforcement boundary: shell and plugin operations may mutate files,
failed commands still count as attempts, a crash may occur around transcript
persistence, and branch navigation can complicate history inspection.

The eligibility decision therefore needs durable server state written before a
disqualifying operation is allowed to execute.

## Goals

- Move an eligible session to another workspace in the same project and on the
  same machine.
- Make the destination workspace the session's real runtime CWD.
- Support both persisted and unpersisted browser-root sessions.
- Preserve persisted history, session name, model policy, pin state, unread
  state, notifications, and browser prompt drafts.
- Keep a persisted session's ID stable across a move.
- Assign a replacement ID only when an unpersisted runtime cannot retain its ID.
- Record browser-root provenance only for sessions created after this feature
  is available.
- Permanently disqualify a session before a write-capable, shell, unknown, or
  tracked-subsession operation executes.
- Make idle and eligibility checks server-authoritative and race-safe.
- Survive daemon restarts and failures at every migration phase without deleting
  the only valid session copy.
- Work through the existing selected-machine federation boundary.
- Remain rolling-compatible with older browsers and older local or remote
  session daemons.

## Non-goals

- Moving sessions between projects or machines.
- Moving archived sessions.
- Moving CLI-created, imported, legacy, `spawn_session`, tracked-subsession,
  forked, or cloned sessions.
- Backfilling provenance for sessions that predate this feature.
- Resetting or manually overriding permanent disqualification.
- Proving which external actor changed a workspace.
- Using workspace Git dirtiness as session eligibility.
- Moving a session tree, parent/child family, or tracked subsession graph.
- Bulk move, drag-and-drop move, or a `/move` slash command.
- Parsing shell text to guess whether a shell command is read-only.
- Making plugin tools trusted by default.
- Providing a distributed lock for multiple sessiond processes that incorrectly
  share one PI WEBUI data directory.

## Relationship to existing approved designs

`2026-08-03-plus-session-model-policy-preference-design.md` proposes a durable
`session-list-plus` creation source for a separate model-preference feature.
That source remains narrower than the move feature's browser-root provenance.

For move eligibility, a **browser-root** includes both:

- a session created through the SESSIONS `+` action; and
- the first session created from an empty-workspace composer.

This broader move term does not make an empty-composer root eligible to write
starter model preferences under the earlier design. Conversely, an existing
`session-list-plus` marker does not backfill move eligibility. A session must
have a record created by the new move-policy store.

If both features are implemented, the session-start orchestration should record
their independent provenance in one creation flow without conflating their
parsers, stores, or eligibility decisions.

## Domain model

### Browser-root session

A **browser-root session** is a top-level session created by the browser-facing
session start route. Agent-owned creation paths call separate service methods
and do not receive this provenance.

The provenance is server-owned. It is not inferred from an absent parent, an
empty transcript, browser cache state, or current selection.

### Move identity

A move-policy identity is the pair:

```ts
interface SessionMoveIdentity {
  sessionId: string;
  cwd: string; // normalized, canonical absolute path
}
```

The CWD is part of the identity because PI WEBUI already uses `{ id, cwd }` for
scoped session lookup and because externally copied session files can repeat a
session ID. A successful move rekeys the policy identity to the destination
CWD.

### Permanent eligibility

A policy record has one of two durable eligibility states:

```ts
type SessionMoveForbiddenReason =
  | "shell"
  | "workspace-write"
  | "unclassifiable-write-target"
  | "unknown-tool"
  | "unknown-extension-command"
  | "workspace-attachment"
  | "tracked-subsession";

type SessionMoveEligibility =
  | { state: "eligible" }
  | {
      state: "forbidden";
      reason: SessionMoveForbiddenReason;
      forbiddenAt: string;
    };
```

`forbidden` is terminal. No operation changes it back to `eligible`, including
moving files back, reverting a workspace change, changing a transcript branch,
compacting, restarting, or repairing Git state.

A missing, malformed, or ambiguous record is ineligible. This is how legacy and
unrecognized sessions fail closed.

### Live movability

Permanent eligibility is necessary but not sufficient. A move is allowed only
when all live conditions also hold:

- the runtime capability is supported;
- the session is a current, non-archived browser root;
- scoped lookup resolves exactly one session with the exact `{ id, cwd }`
  identity; duplicate or prefix-only matches fail closed;
- the permanent policy is eligible;
- no tracked child has ever been created;
- the session is fully idle under `PiSessionService.hasActiveWork()`;
- no other exclusive session mutation is running;
- the source and destination are different known workspaces;
- the destination belongs to the same registered project and machine; and
- no destination session-file conflict exists.

The service rechecks these conditions inside the move's exclusive operation.
Client projections are never authorization.

### Read-only allowlist

Tool and extension operations are read-only only when the server classifies
them through an explicit allowlist. Unknown tools and unknown extension
commands are write-capable by default.

The initial classifier follows these rules:

| Operation | Policy effect |
| --- | --- |
| Explicitly allowlisted read-only tool | No effect |
| `bash` tool | Permanently forbidden |
| Direct shell execution | Permanently forbidden |
| `write` or `edit` proven outside the workspace | No effect |
| `write` or `edit` targeting the workspace | Permanently forbidden |
| `write` or `edit` with an unclassifiable target | Permanently forbidden |
| Unknown or non-allowlisted tool | Permanently forbidden |
| Unknown extension command | Permanently forbidden |
| Session-bound attachment saved into the workspace | Permanently forbidden |
| Tracked subsession creation | Permanently forbidden |

A command counts when it is fired, not when it succeeds. The guard persists the
terminal state before permitting execution.

### Workspace target

A **move target** is another registered workspace resolved by sessiond from the
requested destination CWD. It must share the source workspace's project on the
same daemon. Browser-supplied project IDs or workspace labels are not trusted as
proof of ownership.

### Invariants

1. A policy record is created only for a new browser-root session.
2. Absence never implies browser-root provenance.
3. Forbidden eligibility is monotonic.
4. A disqualifying operation cannot execute for an eligible session until its
   forbidden state is durably committed.
5. Failure to commit that state refuses the operation.
6. Move and disqualification use the same session-exclusive ordering boundary.
7. A persisted move preserves the session ID.
8. An unpersisted move may replace the session ID but preserves user-visible
   session state.
9. A successful move leaves exactly one authoritative active session file or
   runtime identity.
10. Source deletion occurs only after a destination copy and destination runtime
    have both been validated.
11. A crash or retry cannot append the visible move notice twice.
12. A successful move retains eligibility under the destination identity until
    a later disqualifier occurs.

## Accepted behavior

### Eligible read-only session

A newly marked browser-root may contain an arbitrarily long conversation and
may use allowlisted read-only tools. If it remains idle and standalone, Move is
available. After moving, the session resumes with destination workspace
resources, settings, system prompt, and tool CWD.

### Shell command

The first direct shell or `bash` invocation durably sets the policy to forbidden
before execution. This applies even to commands that appear read-only, fail,
are cancelled, or operate outside the workspace.

### Structured write or edit

For a known structured `write` or `edit`, the guard resolves its target against
the source CWD. It checks lexical containment and real path containment when
possible. For a nonexistent target it resolves the nearest existing ancestor.
A path under the workspace, a symlink route into the workspace, or any
classification failure permanently forbids Move.

A target may remain eligible only when the guard can prove that the target is
outside the workspace.

### Unknown operation

An unknown tool or extension command permanently forbids Move. The first version
does not add a public plugin declaration API for read-only trust. Only
code-reviewed, PI WEBUI-owned or Pi built-in operations named in the internal
classifier may be allowlisted. Third-party plugin tools are never trusted as
read-only in version one. New trusted operations must be added deliberately to
the server-owned classifier with tests.

### Tracked child

Before a tracked subsession is created, the parent root becomes permanently
forbidden with reason `tracked-subsession`. Child creation is refused if that
state cannot be persisted. The child is never move-eligible.

### External workspace changes

Changes made by the user, another session, a terminal outside this session, or
another process do not change this session's policy. Workspace Git status may be
dirty while a read-only session remains eligible.

### Repeated moves

A successful move preserves `eligible` under the destination identity. The user
may move the session again while all other requirements continue to hold.

## Shared contracts

### Capability

Add an effective runtime capability:

```text
sessions.moveWorkspace
```

Both web and sessiond must advertise support before the browser exposes the
action. A new browser sends no move-policy or move requests to a peer that does
not advertise the capability.

### Policy projection

`SessionInfo` gains an optional permanent policy projection:

```ts
type SessionMovePolicyProjection =
  | { state: "eligible" }
  | { state: "forbidden"; reason: SessionMoveForbiddenReason };

interface SessionInfo {
  // existing fields
  movePolicy?: SessionMovePolicyProjection;
}
```

An omitted projection means the session was never eligible or the peer does not
support the capability. The server does not expose internal journal paths,
timestamps, or store diagnostics through `SessionInfo`.

A policy transition publishes a global event so connected clients update
without waiting for a session-list refresh:

```ts
{
  type: "session.move-policy";
  session: SessionRef;
  policy: SessionMovePolicyProjection;
}
```

### Move request and response

The selected-machine client sends an application-relative request equivalent
to:

```ts
interface MoveSessionRequest {
  cwd: string;
  targetCwd: string;
  operationId: string;
}

interface MoveSessionResponse {
  operationId: string;
  source: SessionRef;
  session: SessionInfo;
  replacedSessionId?: string;
}
```

`operationId` is a client-generated UUID used for retry and recovery
idempotency. `replacedSessionId` is present only when an unpersisted source was
replaced with a new ID; when present, it equals `source.id` and explicitly tells
clients to retire that old transient identity.

The route is:

```text
POST /sessions/:sessionId/move
```

The body parser is strict, normalizes both CWDs, rejects unknown fields, and
bounds strings before service invocation. The route participates in the
existing selected-machine federation allowlist.

A successful move publishes:

```ts
{
  type: "session.moved";
  operationId: string;
  source: SessionRef;
  session: SessionInfo;
  replacedSessionId?: string;
}
```

The response and event use the same parser and shape. Replaying both is
idempotent in the client.

### Typed conflict reasons

The server distinguishes at least:

```ts
type SessionMoveFailureReason =
  | "session-active"
  | "move-permanently-forbidden"
  | "not-browser-root"
  | "ambiguous-source"
  | "has-tracked-subsessions"
  | "archived"
  | "destination-missing"
  | "same-workspace"
  | "different-project"
  | "destination-conflict"
  | "policy-unavailable"
  | "migration-failed";
```

The transport maps invalid input to `400`, missing source or destination to
`404`, stale eligibility/activity, ambiguous source identity, and destination
conflicts to `409`, and policy persistence unavailability to `503`. The browser
uses the typed reason for stable presentation and treats the accompanying
message as detail.

## Architecture

### SessionMovePolicyStore

Introduce a focused `SessionMovePolicyStore` backed by PI WEBUI-managed state,
not user configuration or project configuration. Its default file is:

```text
$PI_WEBUI_DATA_DIR/session-move-policy.json
```

Conceptually the strict version-one document contains:

```ts
interface SessionMovePolicyFile {
  version: 1;
  sessions: SessionMovePolicyRecord[];
  operations: SessionMoveOperationRecord[];
}
```

A session record contains exactly the canonical identity, `browser-root`
provenance, creation time, eligibility state, and optional first forbidden
detail. An operation record contains the operation ID, source/destination
identities and paths, migration kind, current phase, and optional committed
result.

The store hides:

- strict parsing and unknown-field rejection;
- canonical identity keys and uniqueness checks;
- cloning at interface boundaries;
- one-way eligibility transitions;
- serialized read-modify-write operations;
- atomic temporary-file replacement;
- private file permissions;
- operation idempotency receipts;
- indefinite version-one retention of completed receipts; and
- corruption diagnostics.

A corrupt document is never overwritten automatically. Missing records remain
ineligible. A failed first provenance write leaves the new session valid but
permanently outside this feature. Version one retains completed operation
receipts indefinitely; any future pruning policy requires an explicit file
format migration and must never remove an incomplete operation.

The store's caller-facing operations are intention-revealing:

```ts
interface SessionMovePolicyRepository {
  registerBrowserRoot(identity: SessionMoveIdentity): Promise<void>;
  inspect(identity: SessionMoveIdentity): Promise<SessionMovePolicyInspection>;
  forget(identity: SessionMoveIdentity): Promise<void>;
  forbid(
    identity: SessionMoveIdentity,
    reason: SessionMoveForbiddenReason,
  ): Promise<SessionMovePolicyProjection>;
  beginMove(intent: SessionMoveIntent): Promise<SessionMoveOperationRecord>;
  advanceMove(operationId: string, phase: SessionMovePhase): Promise<void>;
  completeMove(operationId: string, result: MoveSessionResponse): Promise<void>;
  recoverableMoves(): Promise<SessionMoveOperationRecord[]>;
}
```

`forbid()` is idempotent and retains the first reason. Only a successful store
inspection that proves an identity absent or already forbidden allows ordinary
disqualifying work to proceed without a new durable transition. Corrupt or
unreadable state cannot be treated as absence.

Archive retains the move-policy record but suppresses its client projection, so
a later restore keeps the prior eligibility state. Explicit permanent deletion,
archived cleanup, or deletion of an abandoned transient session calls
`forget()` only after the session itself has been irreversibly removed. An
internal transient move replacement suppresses normal browser-root registration
and transfers the source record; it never creates a second eligible record.

### SessionMoveGuard

`SessionMoveGuard` is the only module that maps execution intent to move-policy
effects. It depends on a pure operation classifier, workspace path resolver,
and the policy repository.

It is called at pre-execution boundaries, not from browser transcript events.
The existing `tool_execution_start` event is suitable for UI projection but is
too late to provide a durable-before-execution guarantee by itself.

Required integration points include:

- the agent tool-call execution gate;
- the direct session shell route before `executeBash()`;
- extension command dispatch before unknown commands run;
- session-bound workspace attachment persistence; and
- tracked-subsession creation before a child is started.

For an eligible session, a disqualifying operation waits for `forbid()` to
commit. Store failure rejects the operation. Once the state is forbidden, the
guard publishes `session.move-policy` and then permits the original operation.

### SessionMoveTargetResolver

A small injected resolver proves that source and target CWDs are registered
workspaces in the same project. It reuses the project/workspace services and
canonical path comparison rules already used for path access and spawn target
validation, without trusting client project IDs.

Its result contains canonical source and destination workspace descriptors. A
missing, removed, cross-project, or same-path destination fails before any file
operation.

### SessionFileMigration

A filesystem-focused module owns the persisted JSONL transformation. Callers
provide a validated source file, source CWD, target CWD, resolved destination
session directory, operation ID, and private staging location.

The module:

1. Reads and structurally parses the first JSONL record.
2. Requires a Pi session header with the expected session ID and source CWD.
3. Rewrites only the header `cwd` while retaining every other header field.
4. Copies the remaining bytes unchanged.
5. Creates staged and backup files with private permissions.
6. Validates the staged session through the session-manager gateway.
7. Detects source/destination aliases and destination collisions.
8. Atomically commits or restores the file for the requested phase.
9. Exposes idempotent recovery inspection without choosing policy outcomes.

When source and destination resolve to different session directories, the
module stages in the destination directory so final rename is atomic. When a
global configured session directory makes source and destination paths equal,
it creates a rollback copy and atomically replaces the header in place.

Ad hoc line or string replacement is not permitted. Only the parsed header is
serialized; the remainder of the JSONL is preserved byte-for-byte.

### SessionMoveService

`SessionMoveService` coordinates policy, runtime, target, file, and projection
state behind one command.

It uses the same session-exclusive operation accounting that prevents archive,
tree replacement, and entry mutation races. Prompt delivery, shell execution,
tool execution, archive, and tracked-child creation must all observe that
boundary.

The service owns:

- strict source lookup by `{ id, cwd }`;
- live eligibility and idle rechecks;
- move-journal phases;
- transient versus persisted migration;
- source runtime disposal and destination runtime creation;
- session metadata transfer;
- unread and notification identity rebind;
- visible move notice insertion;
- source retirement;
- global event publication; and
- idempotent retry results.

`PiSessionService` delegates to this module rather than accumulating raw file
migration logic in its already broad implementation.

### Client move coordinator

A focused client coordinator owns dialog state and one move request at a time.
It consumes server policy projections, current session activity, selected
machine capability, current project workspaces, and `session.moved` events.

It hides:

- destination filtering;
- operation ID generation;
- stale dialog/session guards;
- request busy state;
- selected versus background catalog updates;
- old/new ID replacement;
- prompt draft transfer;
- socket reconnection; and
- retryable error state.

`SessionController` remains the owner of selected-session transport and catalog
state. `WorkspaceController` remains the owner of workspace selection. The move
coordinator calls their existing boundaries rather than writing unrelated app
state directly.

## Eligibility recording and disqualification flow

### Browser-root creation

1. The browser calls the existing session start route.
2. The route invokes the service with internal `browser-root` creation intent.
3. Session creation remains authoritative and completes normally.
4. Before the session is exposed as move-eligible, sessiond records its
   `{ id, cwd }` identity in `SessionMovePolicyStore`.
5. The start response and `session.created` event include `movePolicy` only after
   that record succeeds.
6. If move-policy persistence fails, session creation still succeeds, the event
   omits `movePolicy`, and sessiond logs the policy diagnostic. The session is
   never backfilled later.

Agent-owned `spawn_session` and tracked-subsession paths do not pass
`browser-root` intent. Fork and clone replacements do not inherit it.

### Disqualifying tool

1. Pi resolves a tool invocation for an eligible session.
2. The pre-execution gate sends tool name and structured arguments to
   `SessionMoveGuard`.
3. The pure classifier decides read-only, proven-outside write, or
   disqualifying/uncertain.
4. For a disqualifier, the store commits the terminal reason.
5. The guard publishes `session.move-policy`.
6. Only then may tool execution begin.
7. If persistence fails, the tool returns an actionable error and does not run.

### Direct shell

The shell route marks `shell` before calling `executeBash()`. It does not inspect
or parse command text. The same rule applies to queued shell input that was
submitted while browser-side session creation was pending: delivery to the real
session passes through the server guard.

### Tracked child

Tracked-subsession creation marks the parent before creating or prompting the
child. If marking fails, no child is created. Once marked, child-creation
failure does not restore eligibility because the disqualifying operation was
already fired.

## Move transaction

### Common preparation

1. Parse and normalize source CWD, target CWD, session ID, and operation ID.
2. Return a previously committed result when the operation ID and exact request
   match; reject reuse with different input.
3. Resolve and validate same-project source and destination workspaces.
4. Resolve exactly one source session by exact `{ id, cwd }`; reject archived,
   unmarked, duplicate, and prefix-only identities.
5. Acquire the session-exclusive operation boundary.
6. Recheck permanent policy, tracked-child history, and full active-work state.
7. Record a recoverable move intent before mutating runtime or files.

### Persisted source

1. Close the idle source runtime under exclusivity so no later entry can race the
   file copy. If preparation later fails, reopen the source.
2. Resolve the destination session directory using the same environment,
   settings, tilde, and relative-path semantics as normal session creation.
3. Stage and validate the structurally rewritten JSONL.
4. Commit the destination while retaining a recoverable source or backup.
5. Transfer path-keyed metadata, including pin state.
6. Rekey the move-policy identity to the destination while retaining eligible
   state.
7. Rebind unread and notification identity from source CWD to target CWD.
8. Build a destination runtime from the moved session and require its manager
   to report the expected session ID and destination CWD.
9. Require the persisted session model policy and destination runtime resources
   to initialize successfully. Destination-specific configuration failure
   aborts and rolls back the move.
10. Append one visible, non-user move notice naming source and destination. The
    notice carries the operation ID for idempotency, is included in subsequent
    model context, and does not trigger an assistant turn.
11. Remove or retire the source only after destination runtime and notice
    validation.
12. Mark the operation complete and publish `session.moved`.

The moved runtime reloads skills, extensions, settings, system prompt, and other
CWD-scoped resources from the destination. Old transcript content remains
history; the move notice makes the context transition explicit.

### Unpersisted source

1. Read the source runtime's confirmed model policy and user-visible name.
2. Create an internal idle destination runtime with equivalent policy. Suppress
   ordinary browser-root registration because the move transfers the source
   policy record rather than creating a second eligible identity.
3. Validate destination CWD and runtime resources.
4. Transfer the move-policy record to the replacement identity.
5. Stop and remove the old transient runtime only after replacement success.
6. Append the idempotent visible move notice to the replacement.
7. Return the new session and `replacedSessionId`.
8. Publish `session.moved`.

The browser transfers its local prompt draft from old ID to new ID. Other
browsers apply the same event and transfer any draft they independently hold.

The move notice may cause the replacement to become persisted. That is accepted:
the source had no persisted history to preserve, and the destination now has an
auditable record of its origin transition.

### Projection updates

On completion, sessiond:

- removes source workspace activity for the old identity;
- publishes fresh destination status/activity;
- preserves unread and notification ordering under the new CWD;
- returns a `SessionInfo` whose `cwd` and `path` are authoritative; and
- emits one global moved event after the recoverable commit is complete.

## Recovery and idempotency

The journal uses explicit monotonic phases, conceptually:

```text
intent-recorded
source-frozen
candidate-staged
destination-committed
metadata-rebound
destination-opened
source-retired
complete
```

Every phase transition is persisted before the next irreversible step. Recovery
runs before move routes become available.

Recovery rules are deterministic:

- Before destination commit, remove private staging artifacts and restore or
  reopen the source.
- After destination commit but before destination validation, validate the
  destination. Complete only if validation succeeds; otherwise restore source
  and prior metadata.
- After destination validation, finish metadata rebind, source retirement, and
  the idempotent move notice.
- Never delete the sole validated copy.
- Never select between two unvalidated copies by timestamp or file size.
- If safe completion or rollback cannot be proven, retain the source, quarantine
  the stage/destination artifact from normal listing, permanently forbid the
  source policy, and surface an operational diagnostic.

A retry with the same operation ID and input returns the stored result. A retry
with the same operation ID and different input fails. `session.moved` handling
is idempotent, so a browser may receive both the HTTP response and realtime
event in either order.

Version one retains completed operation receipts indefinitely. This keeps
operation-ID retry semantics exact and leaves pruning to a future explicit store
format migration. Normal session listing and global events remain additional
convergence paths, not substitutes for the retained receipt.

## Concurrency

The move's exclusive boundary must cover all operations that can make idle or
eligibility stale:

- prompt and queued-message delivery;
- direct shell execution;
- agent tool execution start;
- extension command execution;
- attachment persistence into the workspace;
- tracked child creation;
- archive and archive-tree;
- fork, clone, and tree replacement;
- model-policy/session-entry mutation; and
- another move.

Exactly one side wins a race:

- If a disqualifying operation commits first, Move observes forbidden state and
  fails before file mutation.
- If Move acquires exclusivity first, new source-CWD work is rejected or waits
  until the moved identity is published; it cannot execute against a partially
  moved runtime.
- If ordinary active work begins first, Move fails with `session-active`.

The browser disables controls while its own move request is pending, but server
serialization remains authoritative across tabs, remote clients, and forged
requests.

## Failure behavior

### Policy persistence unavailable

An otherwise eligible session cannot execute a disqualifying operation unless
the forbidden marker commits. The tool, shell, attachment save, extension
command, or child spawn fails with an actionable policy-persistence error.

Read-only allowlisted operations may continue. Sessions that a successful store
read proves absent or already forbidden may continue ordinary work because they
cannot move. An unreadable or corrupt store cannot be treated as proof of
absence.

### Provenance registration failure

Ordinary session creation remains successful. The session receives no move
projection and is permanently ineligible. PI WEBUI does not retry or infer
provenance later.

### Stale dialog state

The endpoint rechecks policy, activity, source identity, and destination after
acquiring exclusivity. A shell/tool call, archive, workspace removal, or project
topology change after the dialog opened returns a typed conflict without
changing files.

### Candidate or runtime failure

Copy, parsing, header validation, collision, permission, model-policy, resource
loading, destination runtime, or notice failures retain or restore the source.
Private stage files are removed when safe. The browser keeps the dialog open for
a recoverable destination choice and shows the exact failure.

### Corrupt managed state

The store reports invalid state and does not overwrite it. Affected sessions are
ineligible. Move and disqualifying-operation transitions fail closed until the
managed state is repaired.

### Remote connection loss

The daemon continues its journaled operation independently of the HTTP
connection. The browser converges through the idempotent retry, global event, or
normal project/session catalog refresh.

## User interface

### Action availability

The action appears in the session overflow menu and expanded Sessions browser
only when:

- the selected machine advertises `sessions.moveWorkspace`; and
- `SessionInfo.movePolicy` is present.

For an eligible but active session, **Move to workspace...** remains visible but
disabled with the active-session reason. If the current project has no other
workspace, it is disabled with a no-destination reason. After permanent
disqualification it remains visible and disabled with the first server reason.
This explains why a previously available action can no longer run.

Legacy, imported, spawned, forked, cloned, archived, and child sessions omit the
policy projection and never show the action.

### Destination dialog

The dialog:

- identifies the source session and source workspace;
- lists only other workspaces in the current project on the same machine;
- uses the established workspace labels and path secondary text;
- requires one destination selection;
- disables Move while no destination is selected or a request is pending;
- keeps Cancel available until submission begins; and
- reports retryable failures without closing.

No drag interaction or explanatory feature copy is added.

### Successful selected-session move

If the moved session is selected, the app:

1. applies the response/event once;
2. switches to the destination workspace;
3. keeps the moved or replacement session selected;
4. closes the old socket and joins the destination identity;
5. updates current and project-wide session catalogs;
6. transfers the prompt draft when the ID changes; and
7. replaces the route so browser history does not retain the stale source
   identity.

### Successful background move

If the moved session is not selected, the app keeps current navigation and
selection unchanged. It removes the old catalog row, adds the destination row,
and applies later status/activity by session identity.

Another connected browser viewing the source session follows it to the
destination. Browsers not viewing it update catalogs only.

## Security and path handling

- Source identity uses strict `{ id, cwd }` lookup, never an unscoped prefix when
  CWD is available.
- Both CWDs are normalized absolute paths and resolved through registered
  workspace topology.
- Dynamic browser path segments and query values retain the project's
  application-relative URL and encoding conventions.
- Session directory resolution uses Pi's existing configured-directory rules.
- Staging paths are generated by sessiond, not supplied by the browser.
- Header rewriting uses structured JSON parsing.
- Source/destination path aliases, symlinks, and existing destination files are
  detected before retirement.
- Managed policy, journal, backup, and stage files use private permissions.
- A destination conflict never overwrites an existing session file.
- Error responses do not expose journal or private staging paths.

## Verification strategy

Follow test-driven development. Each production behavior begins with a focused
failing test, then the narrow implementation, then broader verification.

### Pure policy and path tests

- Allowlisted read-only tools preserve eligibility.
- `bash` and direct shell always forbid, including harmless and failed commands.
- Unknown tools and extension commands forbid.
- `write`/`edit` relative and absolute paths under the workspace forbid.
- Sibling prefix paths such as `/repo-other` do not count as `/repo`.
- Traversal, symlink, nonexistent target, and nearest-existing-ancestor cases are
  classified correctly.
- Classification uncertainty forbids.
- Proven outside-workspace structured writes preserve eligibility.
- Workspace attachment writes and tracked child creation forbid.

### Policy store tests

- A missing file has no eligible sessions.
- New browser-root registration creates one eligible canonical identity.
- Missing and pre-feature identities remain absent.
- Repeated forbid calls are idempotent and retain the first reason.
- Eligible never returns from forbidden.
- Concurrent register/forbid/move updates serialize without lost records.
- Unknown fields, duplicate identities, invalid CWDs, and invalid phases fail
  strict parsing.
- Failed atomic writes leave the previous document intact and clean temporary
  files.
- Corrupt input blocks mutation without overwrite.
- Final and temporary files retain private permissions.

### Guard integration tests

- The forbidden store write resolves before tool/shell execution starts.
- A failed store write prevents execution.
- Policy transition publishes exactly one global event.
- Absent/already-forbidden sessions do not require a transition to continue
  ordinary work.
- Queued shell delivery after pending browser creation still passes through the
  guard.
- Tracked child creation cannot begin before parent disqualification commits.

### Target and route tests

- Same-project sibling workspaces are accepted.
- Same workspace, missing workspace, and cross-project intent are rejected.
- The selected-machine API carries no target-machine field, so a cross-machine
  move cannot be expressed or forwarded.
- Request and response parsers reject malformed UUIDs, CWDs, unknown fields, and
  invalid projections.
- The federated HTTP contract forwards the move route and body exactly once.
- Capability parsing and effective web/sessiond intersection are rolling-safe.
- New clients send no move request to old peers.

### Persisted migration tests

- Default per-CWD session directories move and rewrite the header.
- Shared global configured directories rewrite atomically in place.
- Workspace-relative configured session directories resolve independently for
  source and destination.
- Every header field except `cwd` remains unchanged.
- Every byte after the header remains unchanged before the move notice append.
- Session ID, name, model policy, pin, unread state, and notifications survive.
- Destination manager and runtime report the target CWD.
- Destination resource/model-policy failure restores the source.
- Existing destination, alias, permission, malformed header, and copy failures
  never overwrite or remove source data.

### Transient migration tests

- Destination runtime receives the current confirmed model policy and name.
- Source remains alive until destination validation succeeds.
- Success returns a new ID and `replacedSessionId`.
- Prompt draft transfer and cached transient cleanup use the new identity.
- Notice persistence and projection are correct.
- Destination creation failure leaves the source selected and usable.

### Journal recovery tests

Inject a process stop after every phase. Construct fresh store, service, and
session-manager instances, run startup recovery, and prove:

- there is one authoritative valid session;
- the only validated copy is never deleted;
- incomplete staging is private and eventually removed or quarantined;
- policy and path metadata match the authoritative CWD;
- the move notice appears at most once;
- completed operation retries return the same response; and
- conflicting operation-ID reuse is rejected.

### Race tests

Use deferred collaborators to race Move against prompt, shell, write-capable
tool, tracked-child spawn, archive, fork/clone, model-policy entry mutation, and
a second move. Assert that exactly one operation wins and no work executes in a
partially moved CWD.

### Client and Lit tests

- Action is hidden without capability or policy projection.
- Eligible idle action is enabled.
- Eligible active and permanently forbidden actions are disabled with exact
  reasons.
- Destination list excludes source and other projects.
- Dialog busy, cancellation, stale completion, and retry behavior are scoped.
- Selected move switches workspace, reconnects the socket, and replaces route.
- Background move preserves current navigation.
- New-ID move transfers drafts and all ID-keyed client state.
- Response/event order is idempotent.
- Other-browser global events repair stale selected and catalog state.

### End-to-end temporary repository test

Create a real Git repository with two worktrees and an isolated Pi session
store. Start a provenance-marked session, perform only read-only operations,
move it, reopen it, and verify:

- it is listed only under the destination CWD;
- history and model policy remain available;
- the runtime system prompt and tool CWD use the destination; and
- a later destination file write works there and permanently disables another
  move.

### Verification commands

Run focused Vitest files while developing each layer. Because the final change
crosses shared contracts, client orchestration, session routes, sessiond runtime
ownership, persistence, and federation, finish with:

```bash
npm run typecheck
npm run lint
git diff --check
npm run verify
```

## Operational and release impact

This feature changes sessiond-loaded code, session runtime execution guards,
the session-daemon protocol, realtime events, managed state, filesystem
migration, federation, and browser behavior.

Implementation and deployment require a manual restart of
`pi-webui-sessiond.service`. UI/API autoreload alone is insufficient.

Add one patch Changeset during implementation. A suitable release note is:

```text
Move eligible read-only user-created sessions between workspaces in the same
project while preserving their history and runtime settings.
```

Do not edit `CHANGELOG.md` directly. Release preparation generates it from
Changesets.

Keep `README.md` unchanged. Document the final user-visible eligibility and
recovery behavior in the Sessions section of `docs/faq.html`. If a broader
canonical session-management page lands before implementation, move that content
to the new canonical page and link to it instead of maintaining duplicate
explanations. Do not duplicate migration internals in user documentation.

## Alternatives rejected

### Browser-only regrouping

Changing `SessionInfo.cwd` or client catalog placement without changing the
runtime would make the interface lie about where tools execute.

### Move-time transcript scan

Scanning JSONL avoids a policy store but cannot provide the required
pre-execution durability, clean transient behavior, or simple crash semantics.
It also couples eligibility to branch/history interpretation.

### Git status attribution

Git status describes current workspace state, not which session caused it. It
cannot detect reverted changes and would incorrectly penalize a read-only
session for another actor's edits.

### Shell command parsing

Shell syntax, subprocesses, scripts, aliases, and extensions make reliable
read/write classification impractical. Treating all shell execution as
write-capable is simple and deterministic.

### Zero-message-only move

Restricting Move to blank sessions would be smaller but would reject useful
long-running read-only conversations that satisfy the agreed safety rule.

### Copy instead of move

Keeping the source would create diverging session identities and leave users to
decide which history is authoritative. A separate future "Duplicate to
workspace" action can serve that different use case.

### Moving tracked families

Rewriting parent and child file links atomically across multiple runtimes would
substantially widen the transaction and failure surface. Permanent
parent-session disqualification keeps this design focused on standalone roots.

### Reusing only JSONL custom entries for policy

A custom entry would force an otherwise transient browser root to persist and
would couple guard durability to session branch history. PI WEBUI-managed
policy state supports transient roots and monotonic eligibility directly.

### Allowing policy persistence failure to pass through

Running a disqualifying command after the marker fails would leave a modified
session apparently movable. Refusing that command is required by the hard
eligibility guarantee.

## Acceptance criteria

1. Only browser-root sessions registered after this feature can expose Move.
2. Existing, imported, CLI, spawned, child, forked, cloned, archived, duplicate,
   and prefix-only session identities never expose or complete Move.
3. The destination is another workspace in the same project and machine.
4. A move changes the real runtime CWD, not only sidebar grouping.
5. A persisted move preserves session ID, history, name, model policy, pin,
   unread state, and notifications.
6. An unpersisted move returns a replacement ID and transfers name, model
   policy, and browser prompt draft.
7. A session may move repeatedly until a permanent disqualifier occurs.
8. Any direct shell or `bash` invocation permanently forbids Move before it
   executes.
9. A structured workspace `write`/`edit`, uncertain target, unknown tool,
   unknown extension command, workspace attachment save, or tracked child
   permanently forbids Move before it executes.
10. Failure to persist required disqualification prevents the operation from
    executing.
11. External workspace changes and Git dirtiness do not affect a session's
    policy.
12. Idle state and all eligibility conditions are rechecked server-side under
    session exclusivity.
13. Move cannot race prompt, tool, shell, archive, tree replacement, child
    spawn, or another move into partial execution.
14. Persisted migration supports Pi default, global configured, and
    workspace-relative configured session directories.
15. Header rewriting is structural and preserves the remainder of JSONL.
16. Source data is removed only after destination file and runtime validation.
17. Recovery from every journal phase leaves one authoritative valid session or
    a retained source plus quarantined artifact; it never deletes the sole valid
    copy.
18. Operation retries and response/realtime event reordering are idempotent.
19. Selected-session moves follow the session to the destination and reconnect;
    background moves preserve current navigation.
20. Older peers hide the feature and continue existing session behavior.
21. Focused policy, guard, route, migration, recovery, race, client, and
    end-to-end tests pass.
22. Typecheck, lint, and the repository merge-level verification gate pass.
23. A patch Changeset and canonical detailed user documentation accompany the
    implementation.
24. Release handoff calls out the required manual session-daemon restart.
