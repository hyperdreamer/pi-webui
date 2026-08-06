# Project Pinning Residual Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining terminal-separator filesystem and load-before-mutation ordering gaps in project pinning.

**Architecture:** Keep the existing atomic registry resolver and per-machine pin queues. Reject dangling targets that syntactically require a directory instead of synthesizing a file leaf, and turn the controller's catalog generation into a shared operation sequence advanced by both loads and pin/unpin intents.

**Tech Stack:** Node.js 22.19+, TypeScript, Vitest, Changesets.

## Global Constraints

- Node.js `>=22.19.0`; do not use newer APIs.
- Add no runtime dependency, `fsync`, filesystem injection, AppState field, or MachineController coupling.
- Preserve unique dotted same-directory temporary files, atomic rename, cleanup/rethrow, trailing newline, existing permission-mode preservation, and the serialized ProjectStore mutation queue.
- Preserve per-machine pin/unpin queues, cross-machine independence, rejection continuation, latest-mutation publication, machine-selection ABA reconciliation, and stale-failure suppression.
- Preserve all existing project pinning, server ordering, parser, route, client path, UI, and archived-session behavior.
- Do not add or edit a Changeset: `.changeset/project-registry-symlink-resolution.md` already accurately covers nested registry links and overlapping pin ordering. Do not edit `CHANGELOG.md`.
- Because `ProjectStore` is loaded by the long-lived session daemon, deployment requires a manual `pi-webui-sessiond.service` restart.

## Task 1: Reject dangling directory-target registry links

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/storage/projectStore.ts:13-70`
- Test: `src/server/storage/projectStore.test.ts:112-230`

**Interfaces:**

- Consumes: private `resolveMissingWriteTarget(filePath: string): Promise<ResolvedWriteTarget>` and the raw candidate path retained by the current resolver.
- Produces: unchanged public `ProjectStore`; dangling symlink targets with a terminal path separator reject as directory targets and create no file.

- [ ] **Step 1: Add relative and absolute failing regressions**

Inside `describe("ProjectStore durable writes", ...)`, add POSIX-only table-driven cases for a configured symlink whose raw target is:

1. relative: `registry-relative/`
2. absolute: `${join(tempDir, "registry-absolute")}/`

For each case:

- create the configured symlink while leaving the target absent;
- call direct `writeFile(configuredPath, "x", "utf8")` and record that the OS rejects with `code: "EISDIR"`;
- call `new ProjectStore(configuredPath).add({ path: "/work/alpha" })` and require rejection with `code: "EISDIR"`;
- assert the configured path remains a symlink;
- assert the separator-stripped target remains absent;
- assert no `.tmp` entry exists in the configured or target parent directory.

Use explicit helper code to capture an `unknown` rejection and assert `toMatchObject({ code: "EISDIR" })`; do not rely only on `toThrow` text.

- [ ] **Step 2: Run the storage suite and confirm red**

Run:

```bash
npm test -- --run src/server/storage/projectStore.test.ts
```

Expected: only the two new ProjectStore assertions fail because current code reports success and creates the separator-stripped target as a regular file; direct-write baseline assertions pass. Existing 16 tests remain green.

- [ ] **Step 3: Reject terminal-separator candidates before leaf synthesis**

Add a small private helper that identifies a terminal path separator using `node:path` platform semantics. On POSIX, backslash remains a valid filename character; on Windows, accept both native `\\` and `/` separators.

When `lstat(candidate)` returns `ENOENT`, check the raw candidate before `dirname`/`basename` synthesis. If it ends in a path separator, throw a deliberate `NodeJS.ErrnoException` with:

- `code = "EISDIR"`
- `syscall = "open"`
- `path = filePath`
- a concise message stating that the project registry path must resolve to a file

Do not invoke a destructive probe to manufacture the OS error. Do not remove or normalize the terminal separator. Ordinary missing file leaves continue through physical-parent resolution unchanged.

- [ ] **Step 4: Run focused and neighboring verification**

Run:

```bash
npm test -- --run src/server/storage/projectStore.test.ts
npm test -- --run src/server/app.projects.test.ts src/server/projects/projectService.test.ts src/server/workspaces/workspaceDeletionRoutes.test.ts
npm run typecheck
npx eslint src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts
git diff --check
```

Expected: all pass. Confirm all earlier symlink, mode, temp cleanup, parser, pin ordering, route, and workspace tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts
git commit -m "fix(projects): reject directory registry targets"
```

Record exact red/green counts, error codes, commit SHA, and clean status in the report.

## Task 2: Order project loads and pin mutations on one catalog sequence

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/controllers/projectController.ts:13-165`
- Test: `src/client/src/controllers/projectController.test.ts:300-580`
- Test: full repository via `npm run verify`

**Interfaces:**

- Consumes: `projectCatalogGeneration`, `loadProjects()`, per-machine pin mutation queues, and `applyPinChange(...)` from the current controller.
- Produces: unchanged public `ProjectController`; every load or pin/unpin intent supersedes earlier catalog operations, so older load success/error/finalization cannot overwrite a newer mutation.

- [ ] **Step 1: Add load-before-mutation success and rejection regressions**

Add two deferred real-controller tests:

1. **Older load success:** start `loadProjects()` with a deferred unpinned response. Before resolving it, complete `pinProject()` with a pinned authoritative list. Assert the pin list publishes and `isLoadingProjects` becomes false. Resolve the older load last; assert it does not publish, does not change the pin list, does not set an error, and does not alter loading state.
2. **Older load failure:** start a deferred load, then complete `unpinProject()` with its authoritative list. Reject the older load last with a distinctive error. Assert the mutation list remains, the old error is not published, and `isLoadingProjects` remains false.

The tests must use the real `ProjectController`, `deferred()`, and state-patch observation. Keep existing queue/ABA tests unchanged.

- [ ] **Step 2: Run the controller suite and confirm red**

Run:

```bash
npm test -- --run src/client/src/controllers/projectController.test.ts
```

Expected: the new success test fails because the older load overwrites the mutation list; the rejection test fails because the older load error remains publishable. Existing 17 tests remain green.

- [ ] **Step 3: Advance one catalog operation sequence on mutation intent**

Rename `projectCatalogGeneration` to `projectCatalogOperationSequence` (or another name that clearly includes loads and mutations).

- `loadProjects()` continues to increment the sequence at start and gates success, catch, and finally by machine id plus captured sequence.
- Every pin/unpin intent increments the same sequence immediately when `applyPinChange` is called, before queueing. Capture that new sequence for the mutation.
- Because the mutation invalidates any in-flight load finalizer, explicitly set `isLoadingProjects: false` when the mutation intent advances the sequence.
- Preserve latest per-machine mutation-order checks. A later load or mutation still makes an earlier mutation stale; latest stale success on the currently reselected machine still reconciles through `loadProjects()`, while stale failures remain suppressed.
- Do not serialize different machines together and do not add state outside `ProjectController`.

Use intention-revealing helper names reflecting an operation sequence, not a load-only generation.

- [ ] **Step 4: Run focused and cross-boundary verification**

Run:

```bash
npm test -- --run src/client/src/controllers/projectController.test.ts
npm test -- --run src/client/src/components/ProjectBrowserDialog.test.ts src/client/src/components/SessionBrowserDialog.test.ts src/client/src/components/ProjectList.test.ts
npm run typecheck
npx eslint src/client/src/controllers/projectController.ts src/client/src/controllers/projectController.test.ts
npm run changelog:status
npm run verify
git diff --check
git status --porcelain
```

Expected: focused tests pass; Changesets report patch only; typecheck, lint, Knip, and all tests pass; no Changeset or `CHANGELOG.md` is modified.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/controllers/projectController.ts src/client/src/controllers/projectController.test.ts
git commit -m "fix(projects): order catalog loads with pin changes"
```

Record exact red/green/full-suite counts, commit SHA, unchanged Changesets, `git diff --check`, and clean status in the report.
