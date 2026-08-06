# Project Registry Physical Symlink Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the intended target of a relative dangling `PI_WEBUI_PROJECTS_FILE` symlink when an ancestor directory is itself a symlink.

**Architecture:** Keep the existing atomic temp-file-and-rename design. In the missing-target fallback, interpret each relative `readlink` result from the canonical physical path of the symlink's containing directory, matching POSIX path resolution; pin the topology with a real-filesystem round-trip regression.

**Tech Stack:** Node.js 22.19+, TypeScript, Vitest, Changesets.

## Global Constraints

- Node.js `>=22.19.0`; do not use newer APIs.
- Add no runtime dependency, `fsync`, filesystem injection, or broader storage abstraction.
- Preserve unique dotted same-directory temporary files, atomic rename, cleanup/rethrow, trailing newline, existing permission-mode preservation, and the serialized mutation queue.
- Only `ENOENT` may enter missing-target resolution; permission, symlink-cycle, and other filesystem errors must propagate.
- Preserve existing project pinning, ordering, parser, route, client, and archived-session behavior.
- Do not edit `CHANGELOG.md` or either existing project-pinning Changeset; add one patch Changeset for `@hyperdreamer/pi-webui`.
- Because `ProjectStore` is loaded by the long-lived session daemon, deployment requires a manual `pi-webui-sessiond.service` restart.

## Task 1: Resolve dangling relative registry links from their physical parent

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/storage/projectStore.ts:34-61`
- Test: `src/server/storage/projectStore.test.ts:112-176`
- Create: `.changeset/project-registry-symlink-resolution.md`

**Interfaces:**

- Consumes: private `resolveMissingWriteTarget(filePath: string): Promise<ResolvedWriteTarget>` and public `new ProjectStore(filePath).add(input)` / `.list()` behavior already present in `src/server/storage/projectStore.ts`.
- Produces: unchanged interfaces; relative dangling symlink targets are resolved from the symlink's physical containing directory before temp-file placement and rename.

- [ ] **Step 1: Add the failing real-filesystem regression**

In `src/server/storage/projectStore.test.ts`, add this test inside `describe("ProjectStore durable writes", ...)` after the existing symlink-preservation test:

```ts
it.skipIf(process.platform === "win32")("resolves a relative dangling symlink from its physical parent", async () => {
  const physicalRoot = join(tempDir, "physical");
  const physicalNestedDir = join(physicalRoot, "nested");
  const intendedRegistryDir = join(physicalRoot, "registry");
  const lexicalRegistryDir = join(tempDir, "registry");
  const logicalDir = join(tempDir, "logical");
  await mkdir(physicalNestedDir, { recursive: true });
  await mkdir(intendedRegistryDir);
  await mkdir(lexicalRegistryDir);
  await symlink(physicalNestedDir, logicalDir);

  const configuredPath = join(logicalDir, "projects.json");
  const intendedPath = join(intendedRegistryDir, "projects.json");
  const lexicalAlternativePath = join(lexicalRegistryDir, "projects.json");
  await symlink("../registry/projects.json", configuredPath);
  const store = new ProjectStore(configuredPath);

  const project = await store.add({ path: "/work/alpha" });

  expect((await lstat(configuredPath)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(intendedPath, "utf8"))).toEqual({ projects: [project] });
  await expect(readFile(lexicalAlternativePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.list()).toEqual([project]);
  expect(await readdir(intendedRegistryDir)).toEqual(["projects.json"]);
});
```

This topology intentionally creates both possible parent directories so the current bug reports a successful write to the wrong lexical path instead of failing early.

- [ ] **Step 2: Run the storage test and confirm the regression fails for the expected reason**

Run:

```bash
npm test -- --run src/server/storage/projectStore.test.ts
```

Expected: FAIL only in the new test because `intendedPath` is absent (or the lexical-alternative assertion/round-trip exposes the same wrong destination). Existing tests remain green. Record the exact failure in the report.

- [ ] **Step 3: Correct the root path resolution**

In the symlink branch of `resolveMissingWriteTarget`, replace lexical-parent resolution:

```ts
candidate = resolve(dirname(candidate), await readlink(candidate));
```

with physical-parent resolution:

```ts
const target = await readlink(candidate);
const physicalParent = await realpath(dirname(candidate));
candidate = resolve(physicalParent, target);
```

`path.resolve` keeps an absolute `target` absolute and resolves a relative target from `physicalParent`. `realpath(dirname(candidate))` is valid here because `lstat(candidate)` just reached the leaf through all ancestors; propagate any unexpected canonicalization error.

- [ ] **Step 4: Run focused green verification**

Run:

```bash
npm test -- --run src/server/storage/projectStore.test.ts
npm test -- --run src/server/app.projects.test.ts src/server/projects/projectService.test.ts
```

Expected: PASS, including the new physical-parent topology, existing symlink/mode tests, all four route mappings, and service typed-error behavior.

- [ ] **Step 5: Add the patch Changeset**

Create `.changeset/project-registry-symlink-resolution.md` exactly as:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Preserve the intended project registry target when a relative `PI_WEBUI_PROJECTS_FILE` symlink sits below another symlinked directory.
```

Do not modify `.changeset/project-pinning.md`, `.changeset/project-pinning-followups.md`, or `CHANGELOG.md`.

- [ ] **Step 6: Run repository verification**

Run:

```bash
npm run changelog:status
npm run verify
git diff --check
git status --porcelain
```

Expected: patch bump only; typecheck, lint, Knip, and all tests pass; no whitespace errors; only the two source/test files and the new Changeset are modified before commit.

- [ ] **Step 7: Commit**

```bash
git add src/server/storage/projectStore.ts src/server/storage/projectStore.test.ts .changeset/project-registry-symlink-resolution.md
git commit -m "fix(projects): resolve registry links from physical paths"
```

After commit, record the commit SHA, exact red/green/full verification counts, `git diff --check`, and clean `git status --porcelain` in the implementer report.
