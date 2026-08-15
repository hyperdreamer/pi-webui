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

`command` is already a string passed unchanged to the terminal runner. The runner starts a shell with `-lc`, so the execution interface already accepts embedded newlines. The current user-facing limitation is the single-line editor control, not the terminal runner or config schema.

The feature branch contains an initial CRUD implementation. This specification is authoritative for completion: the implementation must also add the accepted conflict guard, malformed-file reset path, multiline presentation, validation contracts, and user documentation before integration.

## Accepted Behavior

### Task list

- The existing **Tasks** tab remains the only workspace-task surface.
- The toolbar adds **Add Task** while a valid or missing config is in view mode.
- Each task row keeps **Run** and adds **Edit** and **Delete**.
- Tasks remain in the order stored in the `tasks` array.
- Group headings continue to follow the first occurrence of each group in task order.
- Adding a task appends it to the end of the array.
- Editing replaces the task at its existing array index, even when its ID or group changes.
- Deleting removes only the selected task and closes the gap without reordering other tasks.
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

When adding, the ID is suggested from the title as a lowercase hyphenated value. Suggestion lowercases the title, replaces each run outside `[a-z0-9]` with `-`, and removes leading or trailing hyphens. An empty result becomes `task`; a result beginning with a digit is prefixed with `task-`. The suggestion follows title changes until the user edits the ID directly. A duplicate suggestion is reported for correction rather than silently receiving a numeric suffix. When editing, the existing ID is retained and never changes merely because the title changes.

Title, ID, description, and group are trimmed when saved. Empty optional values are omitted. The command is validated with `command.trim() !== ""` but stored exactly as entered, preserving embedded newlines, indentation, leading whitespace, and trailing newlines.

Save is unavailable until the required values are valid. Validation errors are shown at the relevant field and include duplicate IDs. During Edit, the current task's original ID is excluded from the duplicate check.

Cancel discards the draft without writing. Switching to a different workspace also discards the panel-local draft. Mutation and refresh controls are unavailable while a save or reset write is in flight, preventing duplicate submissions.

### Multiline command scripts

`command` remains a single string in config version 1. No migration or schema-version change is needed.

For example:

```json
{
  "id": "verify",
  "title": "Build and test",
  "command": "set -e\nnpm install\nnpm run build\nnpm test -- --run"
}
```

Running the task makes exactly one `terminal.runCommand()` call with the complete string. All lines share one workspace terminal, shell process, working directory, and environment. The run has one title, one terminal-command status, and combined terminal output.

PI WEBUI does not rewrite shell semantics or inject failure handling. Authors use ordinary shell constructs such as `set -e`, `&&`, `;`, conditionals, and pipes. Without explicit fail-fast semantics, the selected shell determines whether later lines run after a failure, and the task run reports the final shell exit status rather than per-line status.

Single-line commands continue to load, edit, save, and execute unchanged.

### Script presentation

- The editor uses a monospace multiline textarea with vertical resize support and a stable minimum height.
- Helper text says the script runs in one terminal and points to `set -e` or `&&` for fail-fast behavior.
- Task cards render the complete command string in a wrapped, vertically scrollable code block. Long scripts do not widen the panel or push action controls outside it.
- Delete confirmation renders the complete command string in the same wrapped, scrollable style.
- Desktop keeps task actions beside the task copy when space permits. Narrow layouts place actions below the script.

### Delete confirmation

Delete opens a panel-local confirmation state identifying the task by title and showing its full command script. **Cancel** is non-destructive; **Delete Task** performs the guarded config mutation.

The confirmation is not a shell-execution confirmation. A task with `confirm: true` still uses the existing run confirmation separately when the user chooses Run.

## Config Loading And Recovery

The panel distinguishes four config states:

1. **Loaded** - valid version 1 config and an exact source snapshot.
2. **Missing** - no tasks file and a missing-file snapshot.
3. **Invalid** - the complete file was read as text but JSON parsing or schema validation failed; retains the exact invalid source snapshot and diagnostic.
4. **Unavailable** - read failure, binary content, or truncated content; no mutation is allowed.

A missing config is editable. Saving the first task creates `.pi-webui/tasks.json` and its parent directory through the existing workspace file interface.

An invalid config is read-only by default. It exposes an explicit **Reset Tasks File** action. Reset requires confirmation, explains that the current invalid contents will be replaced, and writes this valid empty config:

```json
{
  "version": 1,
  "tasks": []
}
```

Reset is offered only when the full text content was read and retained. It is not offered for binary, truncated, permission-denied, offline, or otherwise unreadable files. Those states retain the existing diagnostic and Refresh path.

Browser-authored configs use canonical JSON with two-space indentation and a final newline. Task-array order and supported task values are preserved. JSON whitespace, object-key order, and unsupported extra fields are not part of the version 1 contract and are not preserved by a browser write.

## Optimistic Conflict Guard

Every Add, Edit, Delete, and Reset mutation is based on the source snapshot from which the user acted.

Immediately before writing, the persistence module re-reads `.pi-webui/tasks.json`:

- a loaded or invalid snapshot must match the current raw text exactly;
- a missing snapshot must still be missing;
- any different content, newly created file, deleted file, read error, binary result, or truncated result blocks the write.

On conflict, PI WEBUI does not call `writeFile`. It keeps an Add/Edit draft visible so the user can review or copy it, reports that the tasks file changed outside the panel, and requires Refresh before another mutation. Refresh does not merge or rebase a stale draft: it explicitly warns that the draft will be discarded, then exits the editor and loads the authoritative file. Delete and Reset return to a non-mutating conflict state with the same Refresh requirement.

After a successful write, the panel reloads the file and adopts a new authoritative snapshot before showing success.

The existing workspace file interface has no compare-and-swap write primitive. The preflight re-read therefore prevents normal stale-browser overwrites but cannot close the narrow race between the final read and `writeFile`. Adding a server-side file revision or conditional-write contract is outside this feature.

## Architecture

### Config domain module

`config.ts` continues to own the version 1 task interface and parser. It also owns pure editor-domain behavior where useful:

- task-ID suggestion and validation;
- task-draft normalization;
- add, replace-at-index, and delete transformations;
- duplicate-ID detection;
- canonical serialization.

These functions operate on values only and do not know about DOM, workspace context, or file I/O.

### Persistence module

`workspaceTasksClient.ts` becomes the deep persistence module for the panel. Its interface exposes loading and guarded writing while hiding raw file errors, snapshot comparison, canonical serialization, and conflict classification.

The load result carries the exact snapshot required for a later mutation. A guarded save accepts `WorkspacePanelContext.files`, the source snapshot, and the next validated config. It either writes and returns the newly loaded state or returns a typed conflict/unavailable result without writing.

Reset uses the same guarded-write path with the retained invalid snapshot. There is no separate unguarded reset implementation.

### Panel element

`tasksPanelElement.ts` owns only presentation and interaction state:

- current workspace context;
- list, Add, Edit, Delete-confirmation, Reset-confirmation, saving, and error states;
- task draft and whether its generated ID has been manually edited;
- focus and event wiring;
- invoking pure domain transformations and the guarded persistence interface;
- running an already-loaded task through the existing runner.

The panel does not duplicate parser rules or directly construct ad hoc JSON writes.

The existing workspace-keyed config cache remains a read optimization. Each editor/delete/reset interaction captures its own immutable source snapshot, so a cache refresh or another panel instance cannot silently change the mutation basis.

### Terminal runner

`taskRunner.ts` remains structurally unchanged. It sends `task.command` once, unchanged, through `terminal.runCommand()` with the existing title, open behavior, and metadata. Focused regression coverage proves multiline strings are not split, joined, trimmed, or dispatched more than once.

No public plugin interface, HTTP route, terminal protocol, or session-daemon code changes.

## Data Flow

### Add or Edit

1. The panel loads a valid config or missing-file state with its source snapshot.
2. The user opens Add or Edit and changes the draft.
3. Pure validation and normalization produce the next task and config while preserving array order.
4. The persistence module re-reads the file and compares it with the captured snapshot.
5. If it differs, the write is refused and the draft remains visible.
6. If it matches, the module writes canonical JSON through `context.files.writeFile()`.
7. The module reloads and parses the file.
8. The panel returns to the task list and reports success only after the authoritative reload succeeds.

### Delete

1. The user selects Delete for a loaded task.
2. The panel shows the task title and complete script in the confirmation state.
3. Confirm computes the next config by removing that task without reordering others.
4. The same snapshot comparison, write, and reload flow applies.

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

- Field validation never writes and keeps the editor open.
- Duplicate IDs identify the conflicting ID before save.
- Snapshot conflicts never write and keep user-authored Add/Edit text available until explicit Refresh or Cancel; Refresh warns before discarding a dirty draft.
- Preflight read failures never fall back to last-write-wins.
- Write or post-write reload failures appear in the panel with actionable Refresh guidance.
- If a write succeeds but the authoritative reload fails, the UI does not claim that the visible cache is current; it shows the reload error and requires Refresh.
- Stale async completions from a previously selected workspace cannot update the current panel state.
- A failed config write does not affect active terminals or command runs.
- Running a multiline task uses existing terminal-run failure reporting; no per-line error interpretation is added.

## Accessibility And Responsive Behavior

- Add, Edit, Delete, Reset, Save, Cancel, and Run are semantic buttons with visible text.
- Every form control has a programmatic label. Required status and validation errors are not conveyed by color alone.
- Add focuses Title. Edit focuses Title while retaining the existing ID. Delete and Reset confirmations start on the safe Cancel action.
- Escape acts as Cancel while no mutation is in flight.
- Focus remains visible in classic, PI WEBUI dark, and PI WEBUI light themes.
- Textarea and script previews fit within the panel at narrow widths without horizontal page overflow.
- Action rows wrap below task content on narrow panels.
- The approved visual reference is the version 2 multiline mockup under the ignored `.superpowers/brainstorm/` artifact directory; it is not shipped application code.

## Testing

Follow test-driven development and use the smallest test layer that proves each contract.

### Config-domain tests

- suggest a valid ID from titles with spaces, punctuation, and leading digits;
- stop updating the generated ID after manual ID input;
- validate required title, command, and ID;
- reject invalid and duplicate IDs, excluding the original task during Edit;
- append Add, replace Edit at the same index, and remove Delete without reordering other tasks;
- trim ordinary text fields while preserving command bytes and newlines exactly;
- serialize canonical two-space JSON with a final newline;
- round-trip existing single-line and multiline version 1 configs.

### Persistence tests

- load valid, missing, invalid-text, binary, truncated, and read-failure states distinctly;
- retain exact loaded and invalid snapshots;
- allow a write only when current raw content matches the source snapshot;
- detect content changes, loaded-to-missing, missing-to-created, read errors, binary, and truncation before write;
- prove every conflict calls `writeFile` zero times;
- reset only a matching complete invalid-text snapshot;
- reload and return the authoritative state after successful writes;
- classify write and post-write reload failures without claiming stale success.

### Panel tests

Use real shadow-DOM interaction where practical to cover:

- Add from loaded and missing states;
- ID suggestion until manual edit;
- Edit prefill and stable ID behavior;
- multiline textarea rendering and exact saved newlines;
- validation and duplicate-ID errors;
- Delete and Reset confirmation/cancellation;
- invalid versus unavailable reset visibility;
- conflict messaging, retained Add/Edit draft, and explicit discard-on-Refresh behavior;
- disabled duplicate submissions while saving;
- stale workspace completion suppression;
- wrapped full-script rendering in task cards and confirmation states;
- existing Run behavior and `confirm: true` behavior.

The module-level cache must have an explicit test reset or be dependency-scoped so tests cannot leak workspace state into one another.

### Runner and browser verification

- assert one exact `terminal.runCommand()` call for a multiline command;
- assert no splitting, joining, or trimming;
- retain the existing single-line runner test;
- use Chromium at desktop and 430-pixel narrow widths to check textarea geometry, wrapped scripts, scroll bounds, action wrapping, focus visibility, and absence of overlapping text.

Run focused Workspace Tasks tests first, then typecheck and lint. Finish with `npm run verify:fast` and `git diff --check`. Run serial `npm run verify` before integration or release.

## Documentation And Release

Update the canonical Workspace Tasks section in both `docs/plugins.md` and `docs/plugins.html`:

- explain Add, Edit, Delete, and Reset behavior;
- include a multiline JSON command example;
- explain one-script/one-terminal execution and shell-controlled fail-fast behavior;
- document optimistic conflict refusal and Refresh;
- retain the trusted-repository shell-command warning.

Keep `README.md` unchanged. Do not edit `CHANGELOG.md` manually.

This is a backward-compatible user-facing capability and uses a **minor Changeset** for `@hyperdreamer/pi-webui`. Update the existing feature Changeset so its release note includes browser CRUD, guarded writes/reset, and multiline command scripts rather than creating overlapping entries for the same feature.

## Scope Boundaries

- No `steps` array or config version 2.
- No per-line or per-step status, retry, timeout, conditional execution model, or separate terminals.
- No automatic insertion of `set -e`, `&&`, or other shell syntax.
- No drag reordering, move-up/down controls, group-management surface, task duplication, search, templates, import, or export.
- No preservation of JSON whitespace, key order, or unsupported extra fields after a browser-authored write.
- No server-side compare-and-swap file revision in this release.
- No public plugin interface, HTTP route, terminal protocol, session-daemon protocol, or runtime-ownership change.
- No README expansion or manual changelog editing.
