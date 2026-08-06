# Project Pinning Follow-up Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `projects.json` writes crash-safe, and make the project routes distinguish "project not found" from a genuine server failure.

**Architecture:** `ProjectStore.write` adopts the temp-file-plus-`rename` pattern already used by `SessionMetadataStore`, so a torn write can never leave an unparseable `projects.json`. `ProjectService` gains a `ProjectNotFoundError` class thrown by `close`, `requireProject`, and `setPinned`; a shared `sendProjectRouteError` helper in `app.ts` maps that class to 404 and every other error to 500 across all four project route handlers.

**Tech Stack:** TypeScript, Node 22, Fastify, Vitest, Changesets.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-06-project-pinning-followups-design.md`. Read it before implementing; it records why each decision was made and what was explicitly ruled out.
- `tsconfig.json` sets `exactOptionalPropertyTypes: true`. Never assign `undefined` to an optional property; build objects with conditional spreads.
- Run tests with `npm test -- --run <path>`. Never run the full suite inside a task; the final verification task owns `npm run verify`.
- Repository test guidance is `.agents/skills/testing-guide/SKILL.md`. Prefer the smallest layer that proves the behavior. `ProjectStore` and `ProjectService` tests use a real `mkdtemp` temp directory; do not introduce an injected filesystem fake.
- Do not edit `CHANGELOG.md`. User-visible changes get a `.changeset/*.md` fragment with package name `@hyperdreamer/pi-webui` and bump type `patch`.
- Commit with Conventional Commit messages. Pre-commit runs `npm run verify:staged`, which typechecks, runs Knip, and runs related tests; a commit that fails it must be fixed, not bypassed.
- Never export a symbol no other module imports yet. Knip runs on every commit and fails on unused exports.
- Do not add `fsync` to either store, and do not convert `resolveWorkspaceContext` consumers to typed errors. Both are explicitly out of scope.
- Do not change pin controls on archived session rows. That finding was reviewed and accepted as designed.
- This branch already contains the project pinning feature and its changeset `.changeset/project-pinning.md`. Do not modify or duplicate that file.

## Task 1: Make projects.json writes atomic

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/storage/projectStore.ts` (the private `write` method and its imports)
- Test: `src/server/storage/projectStore.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `ProjectStore.write` becomes atomic. No public signature changes, so no other module is affected.

**Reference implementation:** `src/server/sessions/sessionMetadataStore.ts`, its private `write` method. Mirror its structure, including the dotted temp-file name shape. Do not copy its injectable `SessionMetadataFileSystem`; `ProjectStore` uses the `node:fs/promises` functions directly.

- [ ] **Step 1: Write the failing test first**

In `src/server/storage/projectStore.test.ts`, add a `describe("ProjectStore durable writes")` block using the same `mkdtemp` / `rm` `beforeEach` / `afterEach` shape as the existing `ProjectStore pin state` block.

Add these tests:

1. A completed mutation leaves no temp file behind. After `add` and then `setPinned`, read the directory with `readdir` and assert no entry ends with `.tmp`.
2. An unrelated pre-existing temp file does not affect a later read. Write a junk file named `.projects.json.stale.tmp` containing `not json` into the directory, then assert `store.list()` still resolves correctly and the junk file is ignored.
3. The written file is complete and parseable. After a mutation, `JSON.parse` the file contents directly and assert it has the expected `projects` array.

Test 1 must fail before the implementation change only if the implementation is wrong; with a bare `writeFile` there is no temp file, so this test passes trivially at first. That is expected and acceptable: its value is as a regression guard on the new mechanism, ensuring the temp file is always cleaned up. Note this explicitly in your report rather than claiming a red-green cycle you did not observe.

- [ ] **Step 2: Implement the atomic write**

Replace the body of the private `write` method so it:

1. `mkdir`s the parent directory recursively, as today.
2. Builds a temp path in the same directory as the target: `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`.
3. Writes the serialized JSON to the temp path.
4. `rename`s the temp path onto `this.filePath`.
5. On any failure, `unlink`s the temp path with `.catch(() => undefined)` and rethrows the original error.

Add `rename` and `unlink` to the existing `node:fs/promises` import and `basename` to the `node:path` import. `randomUUID` is already imported from `node:crypto`.

Keep the trailing newline in the serialized output (`${JSON.stringify(data, null, 2)}\n`) so the file format is unchanged.

Add a short comment explaining that `rename` is what makes a reader see either the old or the new file, never a partial one, and that the `exclusive` queue remains necessary because it prevents lost updates rather than torn files.

- [ ] **Step 3: Verify**

Run: `npm test -- --run src/server/storage/projectStore.test.ts`
Expected: all tests pass, including the pre-existing pin, ordering, and overlapping-mutation lock tests.

Run: `npm test -- --run src/server/workspaces/workspaceDeletionRoutes.test.ts`
Expected: passes. This is the other `ProjectStore` consumer and exercises `add`/`remove`.

- [ ] **Step 4: Commit**

```bash
git add src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts
git commit -m "fix(projects): write projects.json atomically via temp file and rename"
```

## Task 2: Add ProjectNotFoundError to ProjectService

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/projects/projectService.ts`
- Test: `src/server/projects/projectService.test.ts`

**Interfaces:**

- Consumes: Task 1 only incidentally; no dependency on its changes.
- Produces: `export class ProjectNotFoundError extends Error` from `src/server/projects/projectService.ts`. `ProjectService.close`, `ProjectService.requireProject`, and the private `ProjectService.setPinned` reject with it instead of a bare `Error`. The thrown message stays exactly `"Project not found"` so existing response bodies are unchanged.

**Reference precedent:** `SkillsConfigNotFoundError` in `src/server/skills/skillsConfigService.ts:42`.

- [ ] **Step 1: Write the failing tests first**

In `src/server/projects/projectService.test.ts`, add tests asserting that for an unknown id:

- `close` rejects with an error that is `instanceof ProjectNotFoundError`
- `requireProject` rejects with `ProjectNotFoundError`
- `pin` rejects with `ProjectNotFoundError`
- `unpin` rejects with `ProjectNotFoundError`

Also assert the message is still `"Project not found"` in at least one case, pinning the response-body contract that `app.ts` depends on.

Use `await expect(...).rejects.toBeInstanceOf(ProjectNotFoundError)`. Follow the existing file's construction style for the service and its store.

Run the tests and confirm they fail because a bare `Error` is thrown, not because of a typo or a missing import. Record the observed failure in your report.

- [ ] **Step 2: Implement**

Add near the top of `projectService.ts`:

```ts
/** Thrown when a project id does not resolve, so routes can answer 404 without swallowing real failures. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found");
    this.name = "ProjectNotFoundError";
  }
}
```

Replace the three `throw new Error("Project not found")` sites in `close`, `requireProject`, and `setPinned` with `throw new ProjectNotFoundError()`.

Change nothing else. In particular do not touch `add`, which throws a different validation error mapped to 400.

- [ ] **Step 3: Verify**

Run: `npm test -- --run src/server/projects/projectService.test.ts`
Expected: the new tests pass.

Run: `npm test -- --run src/server/app.projects.test.ts`
Expected: still passes. Route behavior is unchanged at this point because the handlers still catch everything as 404.

- [ ] **Step 4: Commit**

```bash
git add src/server/projects/projectService.ts src/server/projects/projectService.test.ts
git commit -m "feat(projects): add a typed ProjectNotFoundError to ProjectService"
```

## Task 3: Map project route errors by class

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/app.ts` (the four project route handlers in `registerLocalProjectRoutes`, plus a new module-level helper)
- Test: `src/server/app.projects.test.ts`

**Interfaces:**

- Consumes: `ProjectNotFoundError` from Task 2.
- Produces: a module-level `sendProjectRouteError(reply, error)` helper in `app.ts`, used by all four project handlers. Unknown ids still answer 404 with `{ error: "Project not found" }`; every other failure answers 500.

**Reference precedent:** `sendSkillsError` in `src/server/skills/skillsConfigRoutes.ts:55-62`. Match its shape: a small module-level function taking `reply` and `error`, deciding the status by `instanceof`.

**Behavior change approved by the requester:** `GET ${prefix}/projects/:projectId/workspaces` currently answers 404 when workspace listing itself fails (git or filesystem error). It will now answer 500. No existing test asserts the old behavior, and client code does not branch on status for these routes.

- [ ] **Step 1: Write the failing test first**

In `src/server/app.projects.test.ts`, add a test proving a store failure is no longer reported as 404. Build the app with a `ProjectService` whose store fails, so the route's error is not a `ProjectNotFoundError`.

Inspect `src/server/app.testSupport.ts` to see how the test context injects dependencies, and use the existing `deps.projects` injection seam if one is available; `buildApp` accepts a `projects` dependency. Construct a `ProjectService` backed by a `ProjectStore` pointed at an unwritable or unreadable path, or a minimal stub whose `setPinned`/`list` rejects with a non-`ProjectNotFoundError`, whichever fits the existing test conventions with less ceremony.

Assert:

1. `POST /api/projects/<id>/pin` with a failing store answers 500, not 404.
2. Unknown ids still answer 404 with body `{ error: "Project not found" }` on all four routes: `DELETE /api/projects/:projectId`, both pin and unpin, and `GET /api/projects/:projectId/workspaces`.

Confirm assertion 1 fails before the implementation, and that it fails by observing 404 rather than by a construction error. Record the observed failure.

- [ ] **Step 2: Implement the helper and apply it**

Add a module-level helper in `app.ts` near the other local helpers:

```ts
function sendProjectRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof ProjectNotFoundError ? 404 : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error) });
}
```

Import `ProjectNotFoundError` from `./projects/projectService.js` alongside the existing `ProjectService` import, and `FastifyReply` from `fastify` if it is not already imported.

Replace the catch bodies of all four handlers (`close` at ~:82, `pin` at ~:90, `unpin` at ~:98, and `workspaces` at ~:115) with `return sendProjectRouteError(reply, error);`.

Leave the `POST ${prefix}/projects` handler alone: it maps validation failures to 400 and is not part of this contract.

Add a brief comment on the helper recording that the wider `resolveWorkspaceContext` consumers deliberately keep their catch-all 404 mapping, so the asymmetry is not read later as an oversight.

- [ ] **Step 3: Verify**

Run: `npm test -- --run src/server/app.projects.test.ts`
Expected: all tests pass, including the new 500 case.

Run: `npm test -- --run src/server/app.workspaceFiles.test.ts`
Expected: passes. It drives the workspaces route heavily and is the most likely place to catch an accidental status regression.

Run: `npm test -- --run src/server/workspaces/workspaceDeletionRoutes.test.ts src/server/app.remoteProxy.test.ts`
Expected: passes. Confirms the untouched `requireProject` consumers and the remote proxy still behave as before.

- [ ] **Step 4: Commit**

```bash
git add src/server/app.ts src/server/app.projects.test.ts
git commit -m "fix(projects): answer 500 instead of 404 when a project route genuinely fails"
```

## Task 4: Add the changeset and verify the whole repository

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/project-pinning-followups.md`
- Test: whole suite via `npm run verify`

**Interfaces:**

- Consumes: Tasks 1 through 3.
- Produces: a `patch` changeset and passing whole-suite verification. No source behavior changes.

- [ ] **Step 1: Write the changeset**

Create `.changeset/project-pinning-followups.md` with exactly this content:

```md
---
"@hyperdreamer/pi-webui": patch
---

Write `projects.json` atomically so an interrupted write can no longer leave the project list unreadable. Project routes now report a genuine server or filesystem failure as a 500 instead of misreporting it as "Project not found".
```

Do not modify `.changeset/project-pinning.md`; it belongs to the feature this branch already contains.

- [ ] **Step 2: Confirm the changeset is valid**

Run: `npm run changelog:status`
Expected: reports `@hyperdreamer/pi-webui` to be bumped at patch, with no minor or major bumps.

- [ ] **Step 3: Check whether documentation needs an update**

Run: `rg -l -i "projects.json|project routes|404" docs/`

Review any hit that documents `projects.json` durability or project route status codes. Update the canonical page only if it makes a claim these changes falsify. Per `.agents/skills/documentation-guide/SKILL.md`, detail belongs under `docs/` and not in `README.md`. If nothing documents these internals, skip this step rather than creating a new page, and say so in your report.

- [ ] **Step 4: Verify the whole suite**

Run: `npm run verify`
Expected: PASS for typecheck, lint, Knip, and all tests. Fix any failure before continuing; do not commit a red verify.

- [ ] **Step 5: Commit**

```bash
git add .changeset/project-pinning-followups.md docs
git commit -m "chore: add changeset for project store and route fixes"
```

If Step 3 produced no documentation change, commit only the changeset file.
