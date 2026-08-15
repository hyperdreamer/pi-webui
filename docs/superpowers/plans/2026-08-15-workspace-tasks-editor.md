# Workspace Tasks Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for readability; do not edit them during execution.

**Goal:** Complete the Workspace Tasks panel editor so users can safely add, edit, delete, reset, and run single-line or multiline version 1 tasks from the browser.

**Architecture:** Keep task parsing, validation, transformations, and serialization as pure value logic in `config.ts`. Move snapshots, guarded writes, same-workspace operation serialization, authoritative cache state, and refresh-required gating into `workspaceTasksClient.ts`; keep `tasksPanelElement.ts` focused on DOM interaction and panel-local state. Preserve the existing terminal runner and public plugin API, then document the shipped behavior in the canonical plugin pages.

**Tech Stack:** TypeScript, Vitest, jsdom, native custom elements and shadow DOM, PI WEBUI plugin API, node-pty-backed `TerminalService`, Markdown/HTML documentation, Changesets.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-08-15-workspace-tasks-editor-design.md` is authoritative.
- Work only in the existing `workspace-tasks-editor` isolated worktree and preserve all existing branch commits.
- Follow TDD for every production behavior: add the focused test, observe the expected RED failure, then write the minimum production change and observe GREEN.
- Do not change config version 1, the `WorkspaceTask.command: string` schema, the public plugin API, HTTP routes, terminal protocol, session-daemon protocol, or runtime ownership.
- Do not add runtime dependencies.
- Do not call `WorkspacePanelContext.files.writeFile()` from `tasksPanelElement.ts`; all task-file writes go through `workspaceTasksClient.ts`.
- Treat snapshot comparison as a best-effort sequential stale-browser guard, not a server-side compare-and-swap guarantee.
- Preserve task-array order; adding appends, editing replaces the captured index, and deleting removes the captured index without reordering the remaining entries.
- Validate command scripts with `trim()` only for emptiness, but persist the textarea's string without trimming, joining, or splitting.
- Use application copy and shell claims from the approved design: one terminal request, server `$SHELL -lc`, and POSIX-compatible `set -e`/`&&` examples rather than shell-neutral guarantees.
- Keep `README.md` and `CHANGELOG.md` unchanged.
- Update the existing `.changeset/workspace-tasks-editor-ui.md` as one minor Changeset; do not create a second overlapping fragment.
- Keep `docs/plugins.md` and `docs/plugins.html` synchronized.
- This work changes web/client-plugin code and tests only; it does not require a manual `pi-webui-sessiond.service` restart.

## Task 1: Add pure task draft, transformation, and serialization contracts

**Implementer tier:** Standard

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/config.ts:1-130`
- Modify: `pi-webui-plugins/workspace-tasks/config.test.ts:1-end`

**Interfaces:**

- Consumes: the existing `WorkspaceTask`, `WorkspaceTasksConfig`, `parseTasksConfig()`, and `parseTasksConfigText()` contracts.
- Produces:

```ts
export type WorkspaceTaskDraftField = "title" | "command" | "id";

export interface WorkspaceTaskDraft {
  id: string;
  title: string;
  command: string;
  description: string;
  group: string;
  confirm: boolean;
}

export type WorkspaceTaskDraftErrors = Partial<Record<WorkspaceTaskDraftField, string>>;

export type ValidateWorkspaceTaskDraftResult =
  | { ok: true; task: WorkspaceTask }
  | { ok: false; errors: WorkspaceTaskDraftErrors };

export function suggestWorkspaceTaskId(title: string): string;
export function validateAndNormalizeDraft(
  draft: WorkspaceTaskDraft,
  existingTasks: readonly WorkspaceTask[],
  originalIndex?: number,
): ValidateWorkspaceTaskDraftResult;
export function appendWorkspaceTask(config: WorkspaceTasksConfig, task: WorkspaceTask): WorkspaceTasksConfig;
export function replaceWorkspaceTaskAt(config: WorkspaceTasksConfig, index: number, task: WorkspaceTask): WorkspaceTasksConfig;
export function removeWorkspaceTaskAt(config: WorkspaceTasksConfig, index: number): WorkspaceTasksConfig;
export function serializeWorkspaceTasksConfig(config: WorkspaceTasksConfig): string;
export const emptyWorkspaceTasksConfig: WorkspaceTasksConfig;
```

- `suggestWorkspaceTaskId()` lowercases, replaces each run outside `[a-z0-9]` with `-`, trims hyphens, returns `task` for an empty result, and prefixes `task-` when the result begins with a digit.
- `validateAndNormalizeDraft()` trims ID/title/description/group, requires ID/title/non-blank command, validates ID with `^[a-z][a-z0-9.-]*$`, detects duplicates while excluding `originalIndex`, omits blank optional fields, defaults/preserves `confirm`, and returns the command string byte-for-byte within JavaScript's string representation.
- Transformation functions return new configs, throw a clear `RangeError` for an invalid captured index, and never reorder untouched tasks.
- `serializeWorkspaceTasksConfig()` emits `version`, `tasks`, then task fields in `id`, `title`, `command`, optional `description`, optional `group`, `confirm` order, with two-space JSON indentation and one final newline.

- [ ] **Step 1: Add focused failing domain tests**

Extend `config.test.ts` with tests equivalent to the following, using the exact exported names above:

```ts
import {
  appendWorkspaceTask,
  emptyWorkspaceTasksConfig,
  removeWorkspaceTaskAt,
  replaceWorkspaceTaskAt,
  serializeWorkspaceTasksConfig,
  suggestWorkspaceTaskId,
  validateAndNormalizeDraft,
  type WorkspaceTask,
  type WorkspaceTaskDraft,
} from "./config";

const baseTasks: WorkspaceTask[] = [
  { id: "first", title: "First", command: "printf first", confirm: false },
  { id: "second", title: "Second", command: "printf second", confirm: true },
];

const draft = (overrides: Partial<WorkspaceTaskDraft> = {}): WorkspaceTaskDraft => ({
  id: "verify",
  title: "Verify",
  command: "  set -e\nnpm test\n",
  description: " details ",
  group: " Quality ",
  confirm: false,
  ...overrides,
});

describe("workspace task editor domain", () => {
  it.each([
    ["Build app", "build-app"],
    ["  $$$  ", "task"],
    ["2026 checks", "task-2026-checks"],
    ["Release...Candidate", "release-candidate"],
  ])("suggests a valid id for %s", (title, expected) => {
    expect(suggestWorkspaceTaskId(title)).toBe(expected);
  });

  it("normalizes ordinary fields while preserving the command string exactly", () => {
    expect(validateAndNormalizeDraft(draft(), baseTasks)).toEqual({
      ok: true,
      task: {
        id: "verify",
        title: "Verify",
        command: "  set -e\nnpm test\n",
        description: "details",
        group: "Quality",
        confirm: false,
      },
    });
  });

  it("reports required, pattern, and duplicate errors and excludes the edited index", () => {
    expect(validateAndNormalizeDraft(draft({ id: "", title: "", command: " \n " }), baseTasks)).toEqual({
      ok: false,
      errors: {
        id: "ID is required.",
        title: "Title is required.",
        command: "Command script is required.",
      },
    });
    expect(validateAndNormalizeDraft(draft({ id: "Bad ID" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: "ID must match ^[a-z][a-z0-9.-]*$." },
    });
    expect(validateAndNormalizeDraft(draft({ id: "second" }), baseTasks)).toMatchObject({
      ok: false,
      errors: { id: "Task ID \"second\" already exists." },
    });
    expect(validateAndNormalizeDraft(draft({ id: "second" }), baseTasks, 1)).toMatchObject({ ok: true });
  });

  it("appends, replaces, and removes without reordering untouched tasks", () => {
    const config = { version: 1 as const, tasks: baseTasks };
    const added = { id: "third", title: "Third", command: "printf third", confirm: false };
    expect(appendWorkspaceTask(config, added).tasks.map((task) => task.id)).toEqual(["first", "second", "third"]);
    expect(replaceWorkspaceTaskAt(config, 0, added).tasks.map((task) => task.id)).toEqual(["third", "second"]);
    expect(removeWorkspaceTaskAt(config, 0).tasks.map((task) => task.id)).toEqual(["second"]);
  });

  it("serializes canonical version 1 JSON with stable key order and a final newline", () => {
    const serialized = serializeWorkspaceTasksConfig({
      version: 1,
      tasks: [{ id: "verify", title: "Verify", command: "set -e\nnpm test", group: "Quality", confirm: false }],
    });
    expect(serialized).toBe('{\n  "version": 1,\n  "tasks": [\n    {\n      "id": "verify",\n      "title": "Verify",\n      "command": "set -e\\nnpm test",\n      "group": "Quality",\n      "confirm": false\n    }\n  ]\n}\n');
    expect(serializeWorkspaceTasksConfig(emptyWorkspaceTasksConfig)).toBe('{\n  "version": 1,\n  "tasks": []\n}\n');
  });
});
```

Also add semantic round-trip coverage for existing single-line and multiline configs, and `RangeError` coverage for invalid transformation indexes.

- [ ] **Step 2: Run the domain test and confirm RED**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/config.test.ts
```

Expected: FAIL because the new editor-domain exports do not exist.

- [ ] **Step 3: Implement the pure domain contracts**

Add only value-level behavior to `config.ts`. Keep DOM, workspace context, file I/O, and cache state out of this module. Build the canonical object explicitly before `JSON.stringify()` so field order is not accidental.

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/config.test.ts
npx eslint pi-webui-plugins/workspace-tasks/config.ts pi-webui-plugins/workspace-tasks/config.test.ts
npm run typecheck
```

Expected: all commands pass with no warnings or TypeScript errors attributable to these files.

- [ ] **Step 5: Commit the domain task**

```bash
git add pi-webui-plugins/workspace-tasks/config.ts pi-webui-plugins/workspace-tasks/config.test.ts
git commit -m "feat(tasks): add editor domain contracts"
```

## Task 2: Implement authoritative loading and guarded workspace persistence

**Implementer tier:** Advanced

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts:1-end`

**Interfaces:**

- Consumes from Task 1:

```ts
serializeWorkspaceTasksConfig(config: WorkspaceTasksConfig): string;
WorkspaceTasksConfig;
```

- Consumes the public workspace file boundary compatible with:

```ts
interface WorkspaceTasksFiles {
  readFile(path: string): Promise<{ content: string; truncated: boolean; binary: boolean }>;
  writeFile(path: string, content: string | Uint8Array): Promise<unknown>;
}
```

- Produces:

```ts
export type WorkspaceTasksSnapshot =
  | { kind: "missing" }
  | { kind: "text"; content: string };

export type WorkspaceTasksConfigLoadResult =
  | { kind: "loaded"; config: WorkspaceTasksConfig; path: string; snapshot: WorkspaceTasksSnapshot }
  | { kind: "missing"; message: string; hint: string; snapshot: WorkspaceTasksSnapshot }
  | { kind: "invalid"; message: string; hint: string; detail: string; snapshot: WorkspaceTasksSnapshot }
  | { kind: "unavailable"; message: string; hint: string; detail?: string };

export type WorkspaceTasksConfigState = { kind: "loading" } | WorkspaceTasksConfigLoadResult;

export interface WorkspaceTasksCacheEntry {
  state: WorkspaceTasksConfigState;
  refreshRequired: boolean;
}

export type GuardedWorkspaceTasksWriteResult =
  | { kind: "written"; state: Extract<WorkspaceTasksConfigLoadResult, { kind: "loaded" }> }
  | { kind: "conflict"; detail: string }
  | { kind: "preflight-unavailable"; detail: string }
  | { kind: "write-failed"; detail: string }
  | { kind: "written-but-unreloaded"; detail: string };

export function loadWorkspaceTasksConfig(files: Pick<WorkspaceTasksFiles, "readFile">): Promise<WorkspaceTasksConfigLoadResult>;
export function getWorkspaceTasksCacheEntry(workspaceKey: string): WorkspaceTasksCacheEntry | undefined;
export function ensureWorkspaceTasksConfig(files: WorkspaceTasksFiles, workspaceKey: string): WorkspaceTasksCacheEntry;
export function refreshWorkspaceTasksConfig(files: WorkspaceTasksFiles, workspaceKey: string): Promise<WorkspaceTasksConfigLoadResult>;
export function guardedWriteWorkspaceTasksConfig(
  files: WorkspaceTasksFiles,
  workspaceKey: string,
  sourceSnapshot: WorkspaceTasksSnapshot,
  nextConfig: WorkspaceTasksConfig,
): Promise<GuardedWorkspaceTasksWriteResult>;
export function subscribeWorkspaceTasksConfig(listener: (workspaceKey: string) => void): () => void;
export function clearWorkspaceTasksStateForTesting(): void;
```

- Missing detection accepts `Path does not exist`, `ENOENT`, and case-insensitive `no such file or directory` messages/codes. Complete text parsing failures are `invalid`, while binary, truncated, directory/non-file, permission, transport, and other read failures are `unavailable`.
- `loadWorkspaceTasksConfig()` retains exact JavaScript text snapshots for loaded/invalid and `{ kind: "missing" }` for missing.
- Cache-miss loads, explicit refreshes, and writes share one FIFO operation chain per workspace key. Every request has a generation; only the latest requested operation in the current test epoch may publish cache state or notify subscribers.
- Each workspace runtime owns an `authoritative`/`refresh-required` gate. Any non-`written` mutation result blocks later mutations before preflight; only a successful explicit refresh yielding loaded, missing, or invalid clears the block. An unavailable refresh stays blocked.
- Guarded writes re-read and compare snapshots, call `writeFile()` only after an exact match, write Task 1's canonical payload, then require a loaded post-write state whose text snapshot exactly equals that payload before returning `written`.
- `clearWorkspaceTasksStateForTesting()` increments a module epoch, clears cache/runtime maps, and prevents pending reads from publishing. It does not claim to cancel an already-started write; tests must await mutation promises before cleanup.

- [ ] **Step 1: Replace the shallow client tests with failing load/snapshot coverage**

Keep the existing path assertion and add strict cases for loaded, missing error variants, invalid text, binary, truncated, and ordinary read failure. Assert the exact result shapes, including snapshots. The invalid case must expect `kind: "invalid"`, not the current `unavailable` result.

- [ ] **Step 2: Add failing guarded-write and queue tests**

Use a small typed in-memory file adapter and controllable deferred promises. Cover all of these observable cases:

```text
matching text -> one canonical write -> exact loaded post-write -> written
matching missing -> one write -> written
text changed -> conflict -> zero writes
loaded snapshot now missing -> conflict -> zero writes
missing snapshot now created -> conflict -> zero writes
preflight read error/binary/truncated -> preflight-unavailable -> zero writes
write rejection -> write-failed
post-write read rejection/invalid/missing/different text -> written-but-unreloaded
matching invalid text + empty config -> written reset
mutation queued after conflict -> rejected before another read/write
successful explicit refresh after conflict -> later mutation can proceed
unavailable explicit refresh -> gate remains blocked
refresh requested during write -> executes after post-write verification
same-key operations are FIFO; different keys do not share a queue
cache clear suppresses a pending load publication and notification
queue cleanup permits a later refresh after an adapter rejection
```

The in-memory write adapter must update its current content before the post-write read so `written` proves the real reload contract rather than a mocked result object.

- [ ] **Step 3: Run persistence tests and confirm RED**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts
```

Expected: FAIL because invalid/snapshot/result/cache/queue exports and guarded writes are absent.

- [ ] **Step 4: Implement classification, cache, queue, and guarded writes**

Implement one private `readCurrentSnapshot()`/classification path used by ordinary load, preflight, and post-write verification. Use a per-key promise tail that always settles its cleanup branch; never hold a global queue across workspace keys. Update `refreshRequired` at the operation boundary and notify subscribers on publishable cache/gate changes. Do not import DOM globals.

- [ ] **Step 5: Run focused GREEN checks**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts
npx eslint pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit the persistence task**

```bash
git add pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts
git commit -m "feat(tasks): guard workspace task writes"
```

## Task 3: Rebuild the panel around guarded CRUD, recovery, and multiline interaction

**Implementer tier:** Capable

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts:1-end`
- Modify: `pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts:1-end` only if the cache reset/subscription contract changes an existing plugin test fixture

**Interfaces:**

- Consumes all Task 1 draft/validation/transformation exports exactly as declared in Task 1.
- Consumes all Task 2 cache/load/refresh/write/subscription exports exactly as declared in Task 2.
- Preserves:

```ts
export const tasksPanelTagName = "pi-webui-workspace-tasks-panel";
export function defineTasksPanelElement(): void;
export function tasksPanelBadge(context: WorkspacePanelContext): string | undefined;
```

- `clearConfigCacheForTesting()` may remain as a compatibility alias that calls `clearWorkspaceTasksStateForTesting()`, but new tests should use one reset consistently.
- The panel creates the workspace key as `${machine.id}:${workspace.projectId}:${workspace.id}` and never writes JSON or calls `files.writeFile()` directly.
- Panel modes are explicit: view, add/edit, delete confirmation, reset confirmation, refresh-discard confirmation, conflicted, and needs-refresh-after-write. A separate in-flight flag distinguishes saving/refreshing and disables duplicate actions.
- Add/Edit capture the current source snapshot; Edit and Delete capture the task array index. Add appends, Edit replaces the captured index, and Delete validates then removes the captured index.
- Add ID suggestion follows title changes only until the first direct ID input. Clearing a manually edited ID remains a validation error.
- The command control is a `<textarea>`; its input value is preserved exactly. The Save state and Save-time result both come from `validateAndNormalizeDraft()`.
- Invalid complete text exposes Reset confirmation; unavailable never exposes Reset. Reset uses `emptyWorkspaceTasksConfig` through the same guarded write path.
- Conflict and uncertain-write outcomes retain Add/Edit drafts, prevent retry with the old snapshot, and require explicit Refresh. Dirty Refresh opens discard confirmation and performs no load until confirmed.
- Every awaited operation captures selection and operation generations. Context switch, disconnect, a newer operation, or test epoch invalidation prevents stale panel mutation/render. Persistence may still publish an authoritative result for its original key.
- One module subscription rerenders connected panels for matching keys and is removed on disconnect.

- [ ] **Step 1: Rewrite the panel fixture into strict, reusable shadow-DOM helpers**

Remove `as unknown as WorkspacePanelContext`, non-null assertions, and optional-click assertions from the existing editor test. Add typed helpers with clear failures:

```ts
interface TasksPanelElement extends HTMLElement {
  context: WorkspacePanelContext | undefined;
}

function requireShadow(panel: HTMLElement): ShadowRoot;
function requireButton(panel: HTMLElement, selector: string): HTMLButtonElement;
function requireInput(panel: HTMLElement, selector: string): HTMLInputElement;
function requireTextarea(panel: HTMLElement, selector: string): HTMLTextAreaElement;
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string): void;
function createContext(overrides?: PartialFixtureOverrides): WorkspacePanelContext;
async function mountLoadedPanel(context: WorkspacePanelContext): Promise<TasksPanelElement>;
```

Build the context object with all required typed members rather than casting an incomplete object through `unknown`.

- [ ] **Step 2: Add failing core CRUD and multiline DOM tests**

Cover Add from loaded and missing states; title-driven ID suggestion; manual ID stop/clear behavior; Edit prefill and stable ID; textarea rendering; exact leading/trailing/newline save; duplicate/pattern/required errors with `aria-invalid` and visible `aria-describedby`; array-order preservation when ID/group changes; Delete cancel/confirm and complete script presentation; and one existing Run/`confirm: true` behavior.

The multiline save test must make the fake adapter expose the canonical write on the post-write read and assert the persisted parsed command equals the exact textarea value, including leading spaces and final newline.

- [ ] **Step 3: Add failing recovery and async ownership tests**

Use controllable promises, never sleeps. Cover:

```text
invalid text shows Reset; binary/truncated/unavailable does not
Reset cancel writes nothing; confirm writes canonical empty config
external content change returns conflict, retains Add/Edit draft, and writes zero times
preflight-unavailable has distinct copy and writes zero times
write-failed and written-but-unreloaded do not claim success
Cancel after conflict discards the draft but Add remains blocked until Refresh
dirty Refresh asks before discard; Cancel returns to the draft; confirm refreshes
double Save and double Delete dispatch only one mutation
workspace switch ignores old refresh/write completion and discards the draft
disconnect ignores completion and removes subscription effects
latest same-workspace refresh is the only completion that publishes to the panel
another panel instance observes refresh-required gating and successful refresh recovery
```

- [ ] **Step 4: Add failing accessibility, focus, keyboard, and presentation tests**

Assert explicit `label[for]`, `aria-required`, polite live status, first invalid control focus, Add/Edit title focus, safe Cancel focus in Delete/Reset, Escape cancellation with stopped propagation, Enter inserting a textarea newline without saving, focus restoration after Cancel/success where the initiating control remains, and full command text in task/delete script blocks.

Assert the shadow style contains component-width behavior (`container-type: inline-size` plus an `@container` rule), `white-space: pre-wrap`, `overflow-wrap: anywhere`, bounded script height/vertical overflow, textarea minimum height/vertical resize, and a visible `:focus-visible` rule. Do not use a viewport-only media query for task-card stacking.

- [ ] **Step 5: Run panel tests and confirm RED**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
```

Expected: FAIL against the current direct-write, single-line, invalid-as-unavailable panel.

- [ ] **Step 6: Implement the panel state machine and rendering**

Replace panel-local config cache/write logic with Task 2. Keep raw HTML construction contained and escape all user content/attributes. Use stable semantic selectors only for tests and focus restoration. Do not rerender on every textarea keystroke in a way that loses the active selection; update validation attributes/messages and Save disabled state in place where possible.

Use complete script blocks (`<pre class="task-script">`) for task cards and confirmations. Use `container-type: inline-size` on the host/panel layout and an `@container` threshold that moves actions below content based on panel width.

- [ ] **Step 7: Run focused GREEN and static checks**

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npx eslint pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 8: Commit the panel task**

```bash
git add pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
git commit -m "feat(tasks): complete guarded task editor UI"
```

If `pi-webui-plugin.test.ts` did not change, omit it from `git add` rather than touching it for bookkeeping.

## Task 4: Pin one-terminal script execution and publish user guidance

**Implementer tier:** Standard

**Files:**

- Modify: `pi-webui-plugins/workspace-tasks/taskRunner.test.ts:1-end`
- Modify: `src/server/terminals/terminalService.test.ts:30-225`
- Modify: `docs/plugins.md:264-318`
- Modify: `docs/plugins.html:385-438`
- Modify: `.changeset/workspace-tasks-editor-ui.md:1-end`

**Interfaces:**

- Consumes the unchanged production runner:

```ts
runWorkspaceTaskInTerminal(
  terminal: WorkspacePanelTerminal,
  task: WorkspaceTask,
): ReturnType<WorkspacePanelTerminal["runCommand"]>;
```

- Produces no new production API. This task pins and documents the existing execution boundary.
- The plugin regression asserts exactly one `runCommand()` call with the exact multiline string, including leading whitespace and a trailing newline.
- The server regression is POSIX-only inside the existing `describe.skipIf(process.platform === "win32")`. It invokes one `TerminalService.runCommand()`, proves a variable/current-directory effect from an earlier line is visible on a later line, observes one terminal and one command run, and verifies the shell process's final exit status. It does not claim shell-neutral `set -e` behavior.
- Documentation explains Add/Edit/Delete/Reset, multiline JSON using escaped `\n`, one request/terminal through server `$SHELL -lc`, POSIX-compatible fail-fast examples, canonical browser saves, best-effort conflict refusal/no merge/Refresh, invalid-text-only Reset, and the trusted-repository warning.
- The Changeset stays `minor` and does not promise preservation of original JSON formatting or unsupported fields.

- [ ] **Step 1: Add the failing multiline runner regression**

Extend `taskRunner.test.ts` with an exact payload such as:

```ts
it("forwards one multiline command without trimming or splitting", async () => {
  const command = "  export BUILD_MODE=ci\nprintf '%s\\n' \"$BUILD_MODE\"\n";
  const task: WorkspaceTask = { id: "verify", title: "Verify", command, confirm: false };
  const runCommand = vi.fn<WorkspacePanelTerminal["runCommand"]>(() => Promise.resolve({ run: { ...run, command }, completed: Promise.resolve({ ...run, command }) }));
  await runWorkspaceTaskInTerminal({ runCommand, open: vi.fn() }, task);
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ command }));
});
```

Run:

```bash
npm test -- --run pi-webui-plugins/workspace-tasks/taskRunner.test.ts
```

Expected: this regression may already pass because production forwarding is already correct. Record that it pins unchanged behavior; do not claim a RED result. To prove falsifiability, temporarily replace `command: task.command` in `taskRunner.ts` with `command: task.command.trim()`, run the focused test and observe failure, then restore the file byte-for-byte and rerun GREEN. Do not commit the mutation.

- [ ] **Step 2: Add and run the POSIX TerminalService regression**

Add one test under the existing non-Windows suite:

```ts
it("runs a multiline script in one terminal and reports the shell exit status", async () => {
  const service = new TerminalService();
  try {
    const marker = "__PI_WEBUI_MULTILINE_TASK__";
    const run = service.runCommand({
      origin: "workspace-tasks",
      projectId: "p1",
      workspaceId: "w1",
      cwd: process.cwd(),
      title: "Multiline task",
      command: `value=${marker}\nprintf '%s\\n' "$value"\nexit 9`,
    });
    expect(service.list(process.cwd()).map((terminal) => terminal.id)).toEqual([run.terminalId]);
    expect(service.listCommandRuns({ metadata: {} }).filter((candidate) => candidate.id === run.id)).toHaveLength(1);
    expect(await terminalExit(service, run.terminalId)).toContain(marker);
    expect(service.getCommandRun(run.id)).toMatchObject({ status: "failed", exitCode: 9, terminalId: run.terminalId });
  } finally {
    service.dispose();
  }
});
```

Run:

```bash
npm run test:serial -- --run src/server/terminals/terminalService.test.ts
```

Expected: PASS. This is a regression for existing terminal behavior, so use the same honesty rule as Step 1: it need not be RED when production already satisfies it.

- [ ] **Step 3: Update canonical Markdown and HTML guidance**

Keep both plugin pages semantically synchronized. The JSON example must remain valid JSON source with escaped line feeds:

```json
{
  "id": "verify",
  "title": "Build and test",
  "command": "set -e\nnpm run build\nnpm test"
}
```

State precisely that browser writes preserve supported task values and array order but canonicalize whitespace/key order and drop unsupported fields. State that a conflict is best-effort refusal for sequential stale edits, not a cross-tab/process atomic guarantee.

- [ ] **Step 4: Correct the existing minor Changeset**

Replace its current formatting-preservation claim with concise user-facing text covering browser CRUD, complete-invalid-text Reset, guarded stale-write refusal, and multiline scripts sent as one terminal run. Keep the existing file and `minor` front matter.

- [ ] **Step 5: Run focused task/plugin/server/docs checks**

Run:

```bash
npm test -- --run \
  pi-webui-plugins/workspace-tasks/config.test.ts \
  pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts \
  pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts \
  pi-webui-plugins/workspace-tasks/taskRunner.test.ts \
  pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/server/terminals/terminalService.test.ts
npx eslint \
  pi-webui-plugins/workspace-tasks/config.ts \
  pi-webui-plugins/workspace-tasks/config.test.ts \
  pi-webui-plugins/workspace-tasks/workspaceTasksClient.ts \
  pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts \
  pi-webui-plugins/workspace-tasks/tasksPanelElement.ts \
  pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts \
  pi-webui-plugins/workspace-tasks/taskRunner.test.ts \
  src/server/terminals/terminalService.test.ts
npm run typecheck
npm run changelog:status
git diff --check
```

Expected: all commands pass; Changesets reports the existing Workspace Tasks minor fragment.

- [ ] **Step 6: Commit terminal coverage, docs, and release metadata**

```bash
git add \
  pi-webui-plugins/workspace-tasks/taskRunner.test.ts \
  src/server/terminals/terminalService.test.ts \
  docs/plugins.md \
  docs/plugins.html \
  .changeset/workspace-tasks-editor-ui.md
git commit -m "docs(tasks): document guarded multiline tasks"
```

## Task 5: Verify browser geometry, package output, and the complete branch

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then remove before commit: a fixture/probe under an ignored `.superpowers/` path or `/tmp`
- Modify only if a measured defect is found: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`
- Modify only with a corresponding regression if needed: `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`

**Interfaces:**

- Consumes the completed Tasks custom element and a strictly typed fake `WorkspacePanelContext`.
- Produces no shipped fixture. Produces recorded command output/measurements in the implementation report.
- Browser acceptance must use real Chromium/CDP, not jsdom geometry. Exercise loaded list, Add/Edit multiline textarea, Delete confirmation, invalid Reset confirmation, field validation, and focus restoration at desktop and `430x844`; inspect classic/dark/light token sets.
- Required measurements: panel/document scroll width versus client width, script bounds and scrollability, script/action overlap, action wrapping, textarea dimensions, visible focus outline, `aria-describedby` resolution, and focus return after Cancel/confirmation.

- [ ] **Step 1: Run the focused workspace task suite from a clean task boundary**

```bash
npm test -- --run \
  pi-webui-plugins/workspace-tasks/config.test.ts \
  pi-webui-plugins/workspace-tasks/workspaceTasksClient.test.ts \
  pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts \
  pi-webui-plugins/workspace-tasks/taskRunner.test.ts \
  pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/server/terminals/terminalService.test.ts
```

Expected: all focused tests pass before browser probing.

- [ ] **Step 2: Run a real Chromium/CDP acceptance probe**

Mount the real custom element with a typed fake context and deterministic file adapter. At desktop and `430x844`, visit list/editor/delete/reset/error states and all three theme token sets. Record numeric results for every measurement named in Interfaces. Use keyboard Tab/Escape/Enter where relevant, not only programmatic `.click()`.

If a defect appears, add or strengthen the narrowest deterministic regression first, observe it fail where jsdom can represent the contract, then make the minimum CSS/DOM fix and rerun focused tests plus the browser probe. Layout-only geometry that jsdom cannot calculate must be documented with before/after Chromium measurements.

- [ ] **Step 3: Remove all temporary probe artifacts and inspect scope**

Run:

```bash
git status --short
git diff --check
git diff --name-only 07a1c6a..HEAD
```

Expected: no temporary fixture is tracked; `README.md`, `CHANGELOG.md`, public plugin API, routes, terminal production code, and session-daemon code are unchanged.

- [ ] **Step 4: Run broad verification serially on an otherwise idle machine**

Run in order, with no parallel full-suite job:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Expected: every command exits 0. `pack:dry` lists the compiled Workspace Tasks plugin under `dist/pi-webui-plugins/workspace-tasks/` and includes `docs/plugins.md`.

- [ ] **Step 5: Commit only if browser verification required a source/test fix**

If and only if Step 2 produced a measured correction:

```bash
git add pi-webui-plugins/workspace-tasks/tasksPanelElement.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts
git commit -m "fix(tasks): keep task editor responsive"
```

Otherwise create no empty verification commit. Finish with a clean worktree and report the exact focused/broad commands, package evidence, and browser measurements. Do not merge, push, publish, or create a release in this task.
