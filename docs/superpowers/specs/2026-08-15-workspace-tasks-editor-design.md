# Workspace Tasks Editor Design

**Date:** 2026-08-15

## Goal

Let users create, edit, and delete Workspace Tasks from the existing **Tasks** workspace panel without manually editing `.pi-webui/tasks.json`.

A task may contain a multiline shell script. PI WEBUI sends that complete script through the existing terminal-command interface as one command run in one workspace terminal. Existing single-line tasks remain compatible.

## Existing Behavior

The bundled `workspace-tasks` plugin currently reads `.pi-webui/tasks.json`, validates its version 1 schema, groups tasks for display, and dispatches each task through `WorkspacePanelContext.terminal.runCommand()`.

The version 1 task interface is:

```typescript
interface WorkspaceTask {
  id: string;
  title: string;
  command: string;
  description?: string;
  group?: string;
  confirm: boolean;
}
```

`command` is already a string passed unchanged from the plugin to the terminal runner. At the plugin seam, the runner sends one `terminal.runCommand()` request. The existing server terminal service then creates one dedicated terminal and invokes the PI WEBUI server process's `$SHELL` with `-lc`; it prepends its existing display banner before the task command. This feature does not alter that execution path. Multiline examples and `set -e` are therefore documented for POSIX-compatible shells supported by the existing terminal service, not as shell-neutral guarantees. The current user-facing limitation is the single-line editor control, not the terminal runner or config schema.

The feature branch contains an initial CRUD implementation. This specification is authoritative for completion: the implementation must also add the accepted conflict guard, malformed-file reset path, multiline presentation, validation contracts, and user documentation before integration.

## Accepted Behavior

### Task list

- The existing **Tasks** tab remains the only workspace-task surface.
- The toolbar adds **Add Task** while a valid or missing config is in view mode.
- Each task row keeps **Run** and adds **Edit** and **Delete**.
- The persisted `tasks` array remains authoritative for task order.
- The existing grouped presentation is retained: a group heading follows the first occurrence of that group, and later tasks in the same group render under that heading. For interleaved groups, visual grouping can therefore differ from global array order; no mutation changes the serialized array order.
- Adding a task appends it to the end of the array.
- Editing replaces the task at its captured array index, even when its ID or group changes.
- Deleting removes only the selected task and closes the gap without reordering the remaining array entries.
- This release does not add manual or drag reordering.

### Panel-local editor

Add and Edit use a focused form inside the Tasks panel rather than a host-level modal. The task list body is replaced while the editor is open, preserving the surrounding workspace and tab context.

The form contains:

- **Title** - required;
- **Command script** - required multiline textarea;
- **ID** - required, editable, and validated against `^[a-z][a-z0-9.-]*$`;
- **Description** - optional;
- **Group** - optional;
- **Require confirmation before running** - boolean checkbox;
- **Save Task** and **Cancel** actions.

When adding, the ID is suggested from the title as a lowercase hyphenated value. Suggestion lowercases the title, replaces each run outside `[a-z0-9]` with `-`, and removes leading or trailing hyphens. An empty result becomes `task`; a result beginning with a digit is prefixed with `task-`. The suggestion follows title changes until the user edits the ID directly. A duplicate suggestion is reported for correction rather than silently receiving a numeric suffix. When editing, the existing ID and array index are retained; changing the title never changes the ID automatically. Once the user edits the ID, clearing it is a validation error and does not reactivate fallback generation.

Title, ID, description, and group are trimmed when saved. Empty optional values are omitted. The command is validated with `command.trim() !== ""` but stored as the textarea's JavaScript string without trimming or joining. Browser textarea line-ending normalization to `\n` is expected; within that browser representation, embedded newlines, indentation, leading whitespace, and trailing newlines are preserved.

One pure `validateAndNormalizeDraft()` operation supplies both Save-button state and Save-time validation. It validates the required title, command, and ID, applies the ID pattern, and checks duplicate IDs while excluding the original task during Edit. Save is unavailable until this result is valid. Validation errors are associated with the relevant controls and remain visible when a submission is rejected.

Cancel discards the draft without writing. Switching to a different workspace discards the panel-local draft. A draft is dirty once it differs from the initial Add defaults or the task values captured for Edit. An open dirty editor cannot be refreshed silently: Refresh first enters a discard-confirmation state. Mutation and refresh controls are unavailable while any Add, Edit, Delete, Reset, or Refresh operation is in flight, preventing duplicate submissions.

### Multiline command scripts

`command` remains a single string in config version 1. No migration or schema-version change is needed.

For example (the `\n` sequences are JSON escapes for embedded line feeds):

```json
{
  "id": "verify",
  "title": "Build and test",
  "command": "set -e\nnpm install\nnpm run build\nnpm test -- --run"
}
```

At the plugin boundary, running the task makes exactly one `terminal.runCommand()` call with the complete command string. The existing terminal service creates one dedicated workspace terminal and one shell invocation, so all task lines share that terminal, process, working directory, and environment. The terminal service's existing display banner is outside the task command and does not split the task into separate runs. The run has one title, one terminal-command status, and combined terminal output.

PI WEBUI does not rewrite the task string or inject failure handling. Authors control shell behavior with constructs such as `set -e`, `&&`, `;`, conditionals, and pipes. The command is executed by the server's `$SHELL -lc` path; examples using `set -e` and POSIX shell syntax are supported examples, not a shell-neutral contract. Without explicit fail-fast semantics, the shell determines whether later lines run after a failure, and the command run reports the resulting shell process exit status rather than per-line status.

Single-line commands continue to load, edit, save, and execute unchanged.

### Script presentation

- The editor uses a monospace multiline textarea with vertical resize support, a stable minimum height, and a bounded initial size.
- Helper text says the script runs in one terminal and points to `set -e` or `&&` for fail-fast behavior.
- Task cards render the complete command string in a block with `white-space: pre-wrap`, `overflow-wrap: anywhere`, bounded height, and vertical scrolling. Long scripts do not widen the panel or push action controls outside it.
- Delete confirmation renders the complete command string in the same wrapped, scrollable style.
- Layout responds to the Tasks panel's available width, not only the browser viewport. Desktop keeps task actions beside the task copy when space permits; narrow panel widths place actions below the script.

### Delete confirmation

Delete opens a panel-local confirmation state identifying the task by title and showing its full command script. **Cancel** is non-destructive; **Delete Task** performs the guarded config mutation.

The confirmation is not a shell-execution confirmation. A task with `confirm: true` still uses the existing run confirmation separately when the user chooses Run.

## Config Loading And Recovery

The panel distinguishes four config states:

1. **Loaded** - valid version 1 config and a complete source snapshot.
2. **Missing** - the path is absent and the source snapshot is explicitly missing.
3. **Invalid** - a complete readable text file was retained, but JSON parsing or schema validation failed; the state retains that exact text snapshot and diagnostic.
4. **Unavailable** - the file could not be used as a complete text snapshot, including read failure, a directory/non-file path, binary content, or a truncated response; no mutation is allowed from this state.

The public file reader returns UTF-8 text previews capped by the existing 512 KiB limit. A text response is complete only when both `binary === false` and `truncated === false`. Exact snapshots therefore compare the reader's complete JavaScript string representation, not inaccessible raw bytes. Missing detection uses the project's existing no-such-file classification (`Path does not exist`, `ENOENT`, and equivalent no-such-file messages), rather than one exact error string.

A conceptual snapshot type is:

```typescript
type WorkspaceTasksSnapshot =
  | { kind: "missing" }
  | { kind: "text"; content: string };
```

Loaded, missing, and invalid results each carry one such snapshot. Unavailable results carry no mutation snapshot. A missing config is editable. Saving the first task creates `.pi-webui/tasks.json` and its parent directory through the existing workspace file interface.

An invalid config is read-only by default. It exposes an explicit **Reset Tasks File** action. Reset requires confirmation, explains that the current invalid contents will be replaced, and writes this valid empty config:

```json
{
  "version": 1,
  "tasks": []
}
```

The canonical reset payload has two-space indentation and a final newline. Reset is offered only when the complete invalid text snapshot was retained. It is not offered for binary, truncated, permission-denied, offline, or otherwise unreadable files. Those states retain the diagnostic and Refresh path.

Browser-authored configs use one canonical serializer: two-space indentation, stable supported-field key order, and a final newline. Task-array order and supported values of untouched tasks are preserved; the task being edited follows the trimming and omission rules above. JSON whitespace, object-key order from the source file, and unsupported extra fields are not part of the version 1 contract and are not preserved by a browser write. A browser save may therefore rewrite a valid file even when the task values are unchanged.

## Optimistic Conflict Guard

Every Add, Edit, Delete, and Reset mutation is based on the source snapshot from which the user acted. Add/Edit captures the current loaded or missing snapshot when the editor opens. Delete captures the loaded snapshot and the task's array index when its confirmation opens. Reset captures the invalid text snapshot when its confirmation opens.

Immediately before writing, the persistence module re-reads `.pi-webui/tasks.json` and classifies the result using the same loader rules:

- a loaded or invalid text snapshot must match the captured text exactly;
- a missing snapshot must still be missing;
- any different content, newly created file, deleted file, read error, binary result, or truncated result blocks the write and does not call `writeFile`.

The guard is a best-effort content check for ordinary stale-browser edits. It is not a compare-and-swap guarantee: two independent browser clients can read the same snapshot, both pass the preflight, and race to write. A server-side file revision or conditional-write primitive would be required to close that race and is outside this feature. Within one browser instance, the persistence module serializes refresh reads and mutations per workspace key, and each panel disables all mutation and Refresh controls while its operation is active.

`workspaceTasksClient.ts` exposes a typed guarded-write result with these observable outcomes:

- **written** - the write completed and an authoritative post-write load returned a valid loaded state whose exact text equals the canonical payload sent to `writeFile`;
- **conflict** - a complete preflight snapshot was obtained but differed from the captured snapshot, so no write was attempted;
- **preflight-unavailable** - the preflight could not establish a complete current snapshot because of a read error, binary/truncated response, or unclassifiable state, so no write was attempted;
- **write-failed** - the write request failed; the outcome may be unknown, so the panel must require Refresh before retrying;
- **written-but-unreloaded** - the write completed but the post-write load failed, returned missing/invalid/unavailable, returned different text, or otherwise could not establish the exact newly written snapshot.

On **conflict**, PI WEBUI reports that the tasks file changed outside the panel. On **preflight-unavailable**, it reports that the current file could not be verified. Neither outcome calls `writeFile`; both keep an Add/Edit draft visible for review/copying and require Refresh before another mutation. Refresh does not merge or rebase a stale draft: it enters an explicit discard-confirmation state, then exits the editor and loads the authoritative file. Delete and Reset enter the same non-mutating refresh-required state.

After **written**, the panel adopts the returned authoritative snapshot before showing success. After **write-failed** or **written-but-unreloaded**, it enters `needs-refresh-after-write`, makes no further mutation automatically, and does not claim that the visible cache is current. Refresh is required to establish a new source snapshot before another mutation.

## Architecture

### Config domain module

`config.ts` continues to own the version 1 task interface and parser. It also owns pure editor-domain behavior:

- task-ID suggestion and validation;
- task-draft normalization and the shared `validateAndNormalizeDraft()` result;
- add, replace-at-index, and delete transformations that preserve array order;
- duplicate-ID detection;
- canonical serialization.

The canonical serializer emits `version` and `tasks`, then task keys in the stable order `id`, `title`, `command`, optional `description`, optional `group`, and `confirm`, with two-space indentation and a final newline. It emits `confirm: false` when the parser supplied the version 1 default. These functions operate on values only and do not know about DOM, workspace context, or file I/O.

### Persistence module

`workspaceTasksClient.ts` becomes the deep persistence module for the panel. Its interface exposes loading and guarded writing while hiding raw file errors, snapshot comparison, canonical serialization, and conflict classification.

The load result carries the exact `WorkspaceTasksSnapshot` required for a later mutation. The guarded mutation interface is conceptually:

```typescript
type GuardedMutationResult =
  | { kind: "written"; state: Extract<WorkspaceTasksConfigLoadResult, { kind: "loaded" }> }
  | { kind: "conflict"; detail: string }
  | { kind: "preflight-unavailable"; detail: string }
  | { kind: "write-failed"; detail: string }
  | { kind: "written-but-unreloaded"; detail: string };

function guardedWrite(
  files: WorkspaceFiles,
  workspaceKey: string,
  snapshot: WorkspaceTasksSnapshot,
  nextConfig: WorkspaceTasksConfig,
): Promise<GuardedMutationResult>;
```

Reset calls the same interface with the canonical empty config. The implementation performs the preflight read, serializes per-workspace mutations, writes only on a matching snapshot, and verifies that the post-write complete text exactly matches the canonical payload before returning `written`. The module, not the panel, is the only caller of `writeFile()`.

The in-process operation queue is keyed by machine ID, project ID, and workspace ID. It serializes cache-miss loads, explicit Refresh reads, and Add/Edit/Delete/Reset mutations across all Tasks panel instances in the browser. A Refresh requested during a mutation runs after that mutation settles, so it cannot publish an observation from between preflight and post-write verification. The queue does not claim to serialize independent browser tabs or processes. A queue entry is released on every result, including thrown adapter errors.

Each workspace queue also owns an `authoritative`/`refresh-required` gate. `conflict`, `preflight-unavailable`, `write-failed`, and `written-but-unreloaded` move the gate to `refresh-required`; any mutation already queued behind that result is rejected without preflight or write. Only a successful explicit Refresh that yields loaded, missing, or invalid complete state restores `authoritative`. An unavailable Refresh leaves the gate blocked. A `written` result keeps the gate authoritative.

Reset uses the same guarded-write path with the retained invalid snapshot. There is no separate unguarded reset implementation.

The read cache stores the latest load result plus a per-key request generation. Every queued load, refresh, or mutation increments that generation. Only the latest requested operation for that key may publish to the cache or dispatch the config-changed event; because operations execute in request order, the latest operation is guaranteed to run after earlier work settles. A guarded write still returns its exact result directly to its initiating panel. A `written` result may install its post-write loaded state when it remains current; every non-written mutation result marks the cached value non-authoritative until a successful explicit Refresh. Cache clearing in tests invalidates generations and pending read publications after in-flight mutation promises have been awaited.

### Panel element

`tasksPanelElement.ts` owns only presentation and interaction state:

- current workspace context and a selection generation;
- list, Add, Edit, Delete-confirmation, Reset-confirmation, refresh-discard-confirmation, saving, conflicted, needs-refresh-after-write, and error states;
- task draft and whether its generated ID has been manually edited;
- focus, keyboard, ARIA, and event wiring;
- invoking pure domain transformations and the guarded persistence interface;
- running an already-loaded task through the existing runner.

The panel does not duplicate parser rules or directly construct ad hoc JSON writes. Every awaited refresh or mutation captures the workspace key and panel selection generation. A completion is ignored after workspace change, disconnect, or a newer operation for that key. Disconnect invalidates the generation and removes listeners; it does not attempt another write or render.

The panel does not silently discard a dirty draft on Refresh. It first shows a discard confirmation. Cancel returns to the editor; confirm invalidates the draft, leaves editor mode, and loads the authoritative state. A clean editor may exit and refresh without confirmation; view mode refreshes directly.

Mutation controls and Refresh are disabled while any mutation or refresh is active. Run remains independent of config mutations, but task Edit/Delete controls are disabled while a task is dispatching as they are today.

### Terminal runner

`taskRunner.ts` remains structurally unchanged. It sends `task.command` once, unchanged, through `terminal.runCommand()` with the existing title, open behavior, and metadata. Focused runner coverage asserts an exact multiline payload and exactly one call. A POSIX-only `TerminalService` regression proves that state set by an earlier script line is visible to a later line, that one command run and terminal are created, and that the documented shell-process exit status is reported. The test does not assert shell-neutral behavior.

No public plugin interface, HTTP route, terminal protocol, or session-daemon code changes.

## Panel State And Async Ownership

The panel uses explicit state transitions rather than inferring mutation state from the cache:

- **view**: displays loaded, missing, invalid, or unavailable state. Add is available only for loaded/missing; Reset is available only for invalid; unavailable exposes Refresh only.
- **editing**: Add or Edit draft is visible. Save is enabled only for a valid `validateAndNormalizeDraft()` result.
- **delete-confirm**: the selected task and script are shown; only Cancel and Delete Task are active.
- **reset-confirm**: the invalid path and replacement warning are shown; only Cancel and Reset Tasks File are active.
- **refresh-discard-confirm**: a dirty draft is protected until the user explicitly confirms discard.
- **saving**: any Add, Edit, Delete, or Reset mutation is pending. All mutation and Refresh controls are disabled; no second mutation is queued from the same panel.
- **refreshing**: a load is pending. All task actions, Refresh, and mutation controls are disabled until an authoritative state is published; Open Terminal remains available.
- **conflicted**: a preflight mismatch or unavailable verification prevented a write, with distinct user-facing messages for those causes. Add/Edit retains its draft for review; Delete/Reset retain the warning and expose Refresh/Cancel only. Cancel may discard the pending draft or confirmation, but the panel remains refresh-required and cannot mutate against the old snapshot. No retry uses the old snapshot.
- **needs-refresh-after-write**: a write failed or completed without an authoritative loaded result. The panel does not claim success, disables further mutation, retains the draft only for review/copying, and requires Refresh. Discarding that draft does not make the old cache authoritative.

Every panel operation captures a workspace selection generation and every cache refresh captures a per-key request generation. A completion may update the panel only if the panel is connected, its selection generation still matches, and the operation is still current. A context change, disconnect, or test cache clear invalidates pending completions. For concurrent refreshes of the same workspace, only the latest request generation may publish to the cache or dispatch the config-changed event.

## Data Flow

### Add or Edit

1. The panel loads a valid config or missing-file state with its source snapshot.
2. The user opens Add or Edit; the panel captures that snapshot and, for Edit, the task's array index.
3. Pure validation and normalization produce the next task and config while preserving array order.
4. The persistence module queues the mutation for the workspace key and re-reads the file.
5. If the snapshot differs or becomes unavailable, the write is refused and the draft remains visible in a conflicted state.
6. If it matches, the persistence module writes canonical JSON; the panel never writes directly.
7. The module performs a post-write load and compares its complete text with the canonical payload just written.
8. Only an exact-match `written` result closes the editor and reports success. A write failure, different post-write text, or uncertain post-write state enters `needs-refresh-after-write` and requires an explicit Refresh.

### Delete

1. The user selects Delete for a loaded task.
2. The panel captures the loaded snapshot and task array index, then shows the task title and complete script in the confirmation state.
3. Confirm computes the next config by removing the captured task at that index. If the current in-memory task at that index no longer has the captured ID, the operation is rejected and Refresh is required.
4. The same queued snapshot comparison, guarded write, and post-write load flow applies.

### Reset

1. A complete text file fails JSON or schema validation.
2. The panel displays the diagnostic and offers Reset Tasks File.
3. Confirmation displays the affected path and explains replacement.
4. The same snapshot comparison guards writing the canonical empty config.
5. A conflict or read failure leaves the invalid file untouched.

### Run

1. The user selects Run.
2. Existing optional run confirmation shows the complete multiline script.
3. `runWorkspaceTaskInTerminal()` calls `terminal.runCommand()` once with the exact `command` string.
4. PI WEBUI opens and switches to the dedicated terminal as it does today.

## Error Handling

- Field validation never writes and keeps the editor open. Validation runs on input for button state and again on Save for correctness.
- Duplicate IDs identify the conflicting ID before save.
- Snapshot conflicts never write and keep user-authored Add/Edit text available until explicit Refresh or Cancel; Refresh warns before discarding a dirty draft.
- Preflight read failures return `preflight-unavailable`; they never fall back to last-write-wins or masquerade as a known content mismatch.
- A failed write has unknown durability from the browser's perspective. It enters `needs-refresh-after-write` rather than automatically retrying.
- If a write succeeds but the authoritative reload fails, returns missing/invalid/unavailable, differs from the canonical payload, or cannot establish the new snapshot, the UI does not claim that the visible cache is current; it shows the reload error, enters `needs-refresh-after-write`, and requires Refresh.
- A completion from a previously selected workspace or disconnected panel cannot update that panel's current state. A still-current persistence operation may publish an authoritative result to its own workspace cache independently of panel connection. Superseded operations and pre-reset test epochs cannot publish stale cache state.
- A failed config write does not affect active terminals or command runs.
- Running a multiline task uses existing terminal-run failure reporting; no per-line error interpretation is added.

## Accessibility And Responsive Behavior

- Add, Edit, Delete, Reset, Save, Cancel, and Run are semantic buttons with visible text.
- Every form control has an explicit `label`/`for` relationship. Required controls expose `aria-required="true"`; invalid controls expose `aria-invalid="true"` and `aria-describedby` pointing to a visible field error. Error/status updates use a panel-local polite live region without stealing focus.
- Add focuses Title after the editor is rendered. Edit focuses Title while retaining the existing ID. Delete and Reset confirmations initially focus the safe Cancel action. After Cancel, Save, Delete, Reset, or a confirmed Refresh, focus returns to the initiating control when it still exists; otherwise focus moves to the panel heading/status region.
- Invalid Save keeps focus on the first invalid control. Successful Save returns focus to the initiating Edit control or Add Task control after the authoritative reload. Conflict and write-uncertain states keep the editor/draft visible. Their live region announces the failure without moving focus from an existing editor control; focus moves to the status region only if the triggering control was removed.
- Escape acts as Cancel for the editor, delete confirmation, reset confirmation, and refresh-discard confirmation while no mutation is in flight. It prevents propagation to host shortcuts. Plain Enter in the multiline textarea inserts a newline and never submits; Save Task remains the explicit submission action.
- Focus remains visible in classic, PI WEBUI dark, and PI WEBUI light themes; controls must use a visible `:focus-visible` treatment and must not remove the browser outline without a replacement.
- Textarea and script previews fit within the panel at narrow widths without horizontal page overflow. Use intrinsic/container-aware layout for panel width rather than relying only on a viewport media query.
- Action rows wrap below task content on narrow panels. Script blocks have bounded height and vertical scrolling.
- The approved visual reference is the version 2 multiline mockup under the ignored `.superpowers/brainstorm/` artifact directory; it is not shipped application code.

## Testing

Follow test-driven development and use the smallest test layer that proves each contract.

### Config-domain tests

- suggest a valid ID from titles with spaces, punctuation, and leading digits;
- stop updating the generated ID after manual ID input;
- validate required title, command, and ID;
- reject invalid and duplicate IDs, excluding the original task during Edit;
- append Add, replace Edit at the same index, and remove Delete without reordering other tasks;
- trim ordinary text fields while preserving the command string's characters and newlines exactly;
- serialize canonical two-space JSON with stable key order and a final newline;
- semantically round-trip existing single-line and multiline version 1 configs (not their original whitespace or key order).

### Persistence tests

- load valid, missing, invalid-text, binary, truncated, and read-failure states distinctly;
- retain exact loaded and invalid snapshots;
- allow a write only when current raw content matches the source snapshot;
- detect content changes, loaded-to-missing, and missing-to-created as `conflict`;
- classify read errors, binary, truncation, and other unverifiable preflight states as `preflight-unavailable`;
- prove every conflict and preflight-unavailable result calls `writeFile` zero times;
- reset only a matching complete invalid-text snapshot;
- reload and return the authoritative state after successful writes;
- classify write failures, post-write reload failures, and post-write text mismatches without claiming stale success;
- serialize same-workspace refreshes and mutations, including Refresh requested before, during, and after a guarded write;
- reject mutations queued behind conflict or uncertain-write outcomes until a successful explicit Refresh, and keep the gate blocked after an unavailable Refresh;
- prove queue cleanup after adapter errors and cache/test reset invalidation of pending publications.

### Panel tests

Use real shadow-DOM interaction where practical to cover. Keep fixtures strictly typed and satisfy the repository ESLint rules; do not use `any`, forbidden assertions, or non-null assertions merely to reach rendered controls. Import the browser-only panel module under the jsdom test environment; keep pure config and persistence tests independent of DOM globals.

- Add from loaded and missing states;
- ID suggestion until manual edit;
- Edit prefill and stable ID behavior;
- multiline textarea rendering and exact saved newlines;
- validation and duplicate-ID errors;
- Delete and Reset confirmation/cancellation;
- invalid versus unavailable reset visibility;
- conflict messaging, retained Add/Edit draft, and explicit discard-on-Refresh behavior;
- disabled duplicate submissions while saving;
- stale workspace, disconnect, superseded-refresh, and same-workspace multi-panel completion suppression;
- refresh-required gating across Cancel and across another Tasks panel instance;
- wrapped full-script rendering in task cards and confirmation states;
- existing Run behavior and `confirm: true` behavior.

The module-level cache must have an explicit test reset that advances an epoch and suppresses pending read publications, or be dependency-scoped so tests cannot leak workspace state into one another. A reset cannot cancel an already started write, so tests must await every mutation promise during fixture cleanup before resetting shared state. Add deterministic controllable promises for stale-refresh, workspace-switch, disconnect, and post-write-reload scenarios; do not use sleeps to prove ordering.

### Runner and browser verification

- assert one exact `terminal.runCommand()` call for a multiline command with leading/trailing whitespace and embedded newlines;
- assert no splitting, joining, or trimming at the plugin seam;
- retain the existing single-line runner test;
- add a POSIX-only `TerminalService` test that runs a multiline script, proves earlier-line state is visible later, records one command run and one terminal, and verifies the shell process exit status;
- perform a manual Chromium/CDP acceptance probe against a temporary fixture that mounts the real Tasks element with a typed fake context and long multiline scripts. At a normal desktop width and an emulated `430x844` viewport, exercise Add/Edit/Delete/Reset states and classic/dark/light theme tokens; measure panel/document scroll widths, script block bounds, action/script rectangle overlap, action wrapping, textarea size, bounded preview scrolling, visible keyboard focus, ARIA error references, and focus restoration. Do not treat `capture:screenshots` or `npm run verify` as substitutes for this probe. Remove the temporary fixture and record the measurements before completion.

Run focused Workspace Tasks tests first, then typecheck, targeted ESLint, and the browser probe. Finish with `npm run verify:fast`, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, and `git diff --check`. `pack:dry` must show the compiled Workspace Tasks plugin under `dist` and `docs/plugins.md` in the package payload. Run the serial `verify` profile on an otherwise idle machine before integration or release.

## Documentation And Release

Update the canonical Workspace Tasks section in both `docs/plugins.md` and `docs/plugins.html`:

- explain Add, Edit, Delete, and Reset behavior;
- include a valid multiline JSON command example with escaped `\n` line feeds;
- explain one-script/one-terminal execution, the server `$SHELL -lc` path, and shell-controlled fail-fast behavior;
- document that browser saves canonicalize version-1 JSON, preserving task order and supported values while discarding source formatting, source key order, and unsupported extra fields;
- state that Reset is available only for a completely read invalid text file and replaces it with an empty version 1 config;
- document optimistic conflict refusal, the lack of draft merging, and the required Refresh;
- retain the trusted-repository shell-command warning.

Keep `README.md` unchanged. Do not edit `CHANGELOG.md` manually.

This is a backward-compatible user-facing capability and uses a **minor Changeset** for `@hyperdreamer/pi-webui`. Update the existing feature Changeset rather than adding an overlapping fragment. Its release note must describe browser CRUD, invalid-config recovery, guarded writes, and one-terminal multiline scripts; it must promise task order and supported-value preservation, not file formatting preservation.

## Scope Boundaries

- No `steps` array or config version 2.
- No per-line or per-step status, retry, timeout, conditional execution model, or separate terminals.
- No automatic insertion of `set -e`, `&&`, or other shell syntax.
- No drag reordering, move-up/down controls, group-management surface, task duplication, search, templates, import, or export.
- No preservation of JSON whitespace, key order, or unsupported extra fields after a browser-authored write.
- No server-side compare-and-swap file revision in this release.
- No public plugin interface, HTTP route, terminal protocol, session-daemon protocol, or runtime-ownership change.
- No README expansion or manual changelog editing.
