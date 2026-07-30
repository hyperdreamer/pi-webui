# Foreground Project-Selection Topology Freshness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a selected project’s newest successfully applied catalog topology authoritative when an older foreground project-load request settles later.

**Architecture:** `WorkspaceController` will own a private, generation-scoped pending foreground project-selection context. A foreground workspace response or a validated background catalog snapshot can complete that context exactly once. Background topology remains ordered by its existing request token; the new context controls only the initial selection side effect, so a newer request that fails does not discard a still-current foreground response.

**Tech Stack:** TypeScript, Lit client state controllers, Vitest, Changesets, npm.

## Global Constraints

- Preserve the existing client application-relative URL behavior; this change does not add URLs or network endpoints.
- Keep all selection-effect state private to `WorkspaceController`; do not add a transient request field to `AppState`.
- A matching selection scope requires machine ID, selected project ID, selected project path, the current catalog-project path, and the active foreground request generation.
- A newer successfully applied catalog snapshot may fulfill the pending selection; merely starting a newer request may not invalidate a successful current foreground response.
- Do not change `src/server/sessiond.ts`, session ownership, the session-daemon protocol, or service restart requirements.
- Do not stage or alter the existing untracked `.superpowers/` evidence directory. It will be superseded by a new security handoff after the final release candidate exists.
- Add a `patch` Changeset. `v1.10.3` must be regenerated from the restored `1.10.2` release-prep state after the correction passes verification.

---

### Task 1: Define the failing foreground-versus-catalog regressions

**Files:**
- Modify: `src/client/src/controllers/workspaceController.test.ts:34-231` and the catalog-reconciliation test group beginning near line 259

**Interfaces:**
- Consumes: public `WorkspaceController.selectProject(project, target?)`, `captureProjectCatalogTopologyRequest(scope)`, and `reconcileProjectCatalog(snapshot)`.
- Produces: three focused regressions defining the required stale-success, same-ID/path-replacement, and stale-error behavior.

- [ ] **Step 1: Add the stale foreground-success test before changing controller code**

Insert a test near the existing selection tests that starts an unresolved foreground workspace list, lets a newer ordered catalog snapshot select the requested fresh workspace, then settles the old foreground response:

```ts
it("keeps a newer catalog topology when a foreground project load settles late", async () => {
  const staleWorkspaces = [mainWorkspace];
  const currentWorkspaces = [mainWorkspace, featureWorkspace];
  const foregroundWorkspaces = deferred<Workspace[]>();
  const selectedSessionIds: string[] = [];
  let state: AppState = { ...initialAppState(), projects: [project] };
  const controller = new WorkspaceController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    {
      clearActiveSession: () => undefined,
      preferredSession: (_cwd, sessions) => sessions[0],
      selectSession: (selected) => {
        selectedSessionIds.push(selected.id);
        return Promise.resolve();
      },
    },
    new InMemoryWorkspaceSelectionMemory(),
    {
      api: {
        workspaces: () => foregroundWorkspaces.promise,
        sessions: (cwd) => Promise.resolve(cwd === featureWorkspace.path ? [spawnedSession] : [parentSession]),
      },
    },
  );

  const selecting = controller.selectProject(project, { workspaceId: featureWorkspace.id });
  const topologyRequest = controller.captureProjectCatalogTopologyRequest({
    machineId: "local",
    projectId: project.id,
    projectPath: project.path,
  });
  await controller.reconcileProjectCatalog({
    machineId: "local",
    project,
    workspaces: currentWorkspaces,
    topologyRequest,
  });

  expect(state.workspaces).toEqual(currentWorkspaces);
  expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);

  foregroundWorkspaces.resolve(staleWorkspaces);
  await selecting;

  expect(state.workspaces).toEqual(currentWorkspaces);
  expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);
  expect(state.selectedWorkspace).toEqual(featureWorkspace);
  expect(selectedSessionIds).toEqual([spawnedSession.id]);
});
```

- [ ] **Step 2: Run the new test and confirm it fails for the stale overwrite**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts
```

Expected before implementation: the new test fails because the delayed `selectProject()` response applies `staleWorkspaces`, replacing the fresh catalog projection or changing the selected workspace.

- [ ] **Step 3: Add the same-ID/path-replacement and stale-error regressions**

Use two deferred foreground calls and a replacement project object so the second context owns the current selection. The replacement snapshot must win over the first old-path response:

```ts
it("does not restore an old-path foreground topology after the same project ID is retargeted", async () => {
  const replacementProject = { ...project, path: "/workspace-replacement" };
  const oldMain = workspace(project, "workspace-1", project.path);
  const replacementMain = workspace(replacementProject, "workspace-1", replacementProject.path);
  const oldForeground = deferred<Workspace[]>();
  const replacementForeground = deferred<Workspace[]>();
  const workspaces = vi.fn()
    .mockImplementationOnce(() => oldForeground.promise)
    .mockImplementationOnce(() => replacementForeground.promise);
  const harness = controllerForCatalog({ projects: [project], listWorkspaces: workspaces });

  const oldSelecting = harness.controller.selectProject(project);
  harness.apply({ projects: [replacementProject] });
  const replacementSelecting = harness.controller.selectProject(replacementProject);
  const topologyRequest = harness.controller.captureProjectCatalogTopologyRequest({
    machineId: "local",
    projectId: replacementProject.id,
    projectPath: replacementProject.path,
  });
  await harness.controller.reconcileProjectCatalog({
    machineId: "local",
    project: replacementProject,
    workspaces: [replacementMain],
    topologyRequest,
  });

  oldForeground.resolve([oldMain]);
  replacementForeground.resolve([oldMain]);
  await Promise.all([oldSelecting, replacementSelecting]);

  expect(harness.state.selectedProject).toEqual(replacementProject);
  expect(harness.state.workspaces).toEqual([replacementMain]);
  expect(harness.state.workspacesByProjectId[replacementProject.id]).toEqual([replacementMain]);
  expect(harness.state.selectedWorkspace).toEqual(replacementMain);
});

it("ignores a stale foreground project-load failure after catalog selection completes", async () => {
  const foregroundWorkspaces = deferred<Workspace[]>();
  const currentWorkspaces = [mainWorkspace, featureWorkspace];
  let state: AppState = { ...initialAppState(), projects: [project] };
  const controller = new WorkspaceController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    sessionControllerStub(),
    new InMemoryWorkspaceSelectionMemory(),
    {
      api: {
        workspaces: () => foregroundWorkspaces.promise,
        sessions: () => Promise.resolve([]),
      },
    },
  );

  const selecting = controller.selectProject(project);
  const topologyRequest = controller.captureProjectCatalogTopologyRequest({
    machineId: "local",
    projectId: project.id,
    projectPath: project.path,
  });
  await controller.reconcileProjectCatalog({
    machineId: "local",
    project,
    workspaces: currentWorkspaces,
    topologyRequest,
  });

  foregroundWorkspaces.reject(new Error("stale foreground workspace load"));
  await selecting;

  expect(state.workspaces).toEqual(currentWorkspaces);
  expect(state.workspacesByProjectId[project.id]).toEqual(currentWorkspaces);
  expect(state.selectedWorkspace).toEqual(mainWorkspace);
  expect(state.error).toBe("");
});
```

- [ ] **Step 4: Run the focused file and verify all three additions fail for the intended pre-fix reasons**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts
```

Expected before implementation: the stale-success/path tests expose old projection restoration; the stale-error test exposes the old foreground error being written after catalog completion. If a new test fails for setup/type reasons, correct only the test setup and rerun until it demonstrates the missing behavior.

- [ ] **Step 5: Keep the red regression changes uncommitted while moving directly to Task 2**

Do not commit a knowingly failing tree to `main`. The next task makes the same focused test file green before any source/test commit.

### Task 2: Make `WorkspaceController` complete foreground selection from fresh topology

**Files:**
- Modify: `src/client/src/controllers/workspaceController.ts:14-110, 210-280, and private helpers after line 309`
- Test: `src/client/src/controllers/workspaceController.test.ts`

**Interfaces:**
- Consumes: `Project`, `RouteTarget`, `ProjectCatalogSnapshot`, `ProjectCatalogTopologyRequest`, `selectPreferredWorkspace()`, and the existing `selectWorkspace()` catalog-scope guard.
- Produces: private `PendingProjectSelection` state, a current-context predicate, and one completion helper used by both foreground and background paths.

- [ ] **Step 1: Add private request-context types and fields**

Add a focused type beside the existing catalog-selection types and controller fields:

```ts
interface PendingProjectSelection {
  request: number;
  machineId: string;
  project: Project;
  target: RouteTarget | undefined;
}

private projectSelectionRequest = 0;
private pendingProjectSelection: PendingProjectSelection | undefined;
```

Keep this state private. It models one in-flight side effect and must not be copied into `AppState`.

- [ ] **Step 2: Add context lifecycle and current-scope helpers**

Add helpers with these contracts:

```ts
private beginProjectSelection(project: Project, target: RouteTarget | undefined): PendingProjectSelection {
  const pending: PendingProjectSelection = {
    request: ++this.projectSelectionRequest,
    machineId: selectedMachineId(this.getState()),
    project,
    target,
  };
  this.pendingProjectSelection = pending;
  return pending;
}

private invalidatePendingProjectSelection(): void {
  this.projectSelectionRequest += 1;
  this.pendingProjectSelection = undefined;
}

private isPendingProjectSelectionCurrent(pending: PendingProjectSelection | undefined): pending is PendingProjectSelection {
  if (pending === undefined
    || this.pendingProjectSelection !== pending
    || pending.request !== this.projectSelectionRequest) return false;
  const state = this.getState();
  const currentProject = state.projects.find((candidate) => candidate.id === pending.project.id);
  return selectedMachineId(state) === pending.machineId
    && state.selectedProject?.id === pending.project.id
    && state.selectedProject?.path === pending.project.path
    && currentProject?.path === pending.project.path;
}
```

Call `invalidatePendingProjectSelection()` at the start of `clearSelection()`. Beginning a new foreground selection replaces the old pending context through `beginProjectSelection()`.

- [ ] **Step 3: Add a single completion helper**

Add an async helper that consumes a current context only once and uses the supplied workspaces to honor the remembered/route-target preference:

```ts
private async completePendingProjectSelection(
  pending: PendingProjectSelection,
  workspaces: Workspace[],
  catalogScope?: CatalogWorkspaceSelectionScope,
): Promise<void> {
  if (!this.isPendingProjectSelectionCurrent(pending)
    || (catalogScope !== undefined && !this.isCatalogSelectionScopeCurrent(catalogScope))) return;

  this.pendingProjectSelection = undefined;
  const workspace = selectPreferredWorkspace(workspaces, {
    targetWorkspaceId: pending.target?.workspaceId,
    latestWorkspaceId: this.workspaceSelection.latestWorkspaceId(machineProjectKey(pending.machineId, pending.project.id)),
  });
  if (workspace !== undefined) {
    await this.selectWorkspace(workspace, {
      sessionId: pending.target?.sessionId,
      updateUrl: pending.target?.updateUrl,
      ...(catalogScope === undefined ? {} : { catalogScope }),
    });
    return;
  }

  this.setState({ isLoadingWorkspaces: false });
  if (pending.target?.updateUrl !== false) this.updateUrl();
}
```

The helper must not reapply a catalog snapshot. `reconcileProjectCatalog()` already owns that projection mutation.

- [ ] **Step 4: Route `selectProject()` through the context**

Replace the direct machine/project-ID completion guard with the pending context flow:

```ts
async selectProject(project: Project, target?: RouteTarget) {
  this.projectSessionsRequest += 1;
  const pending = this.beginProjectSelection(project, target);
  this.sessions.clearActiveSession();
  this.setState({
    selectedProject: project,
    selectedWorkspace: undefined,
    workspaces: [],
    isLoadingWorkspaces: true,
    ...resetWorkspaceScopedState(),
  });
  try {
    const workspaces = await this.api.workspaces(project.id, pending.machineId);
    if (!this.isPendingProjectSelectionCurrent(pending)) return;
    this.applyProjectWorkspaceProjection(project, workspaces, pending.machineId);
    await this.completePendingProjectSelection(pending, workspaces);
  } catch (error) {
    if (!this.isPendingProjectSelectionCurrent(pending)) return;
    this.pendingProjectSelection = undefined;
    this.setState({ error: String(error), isLoadingWorkspaces: false });
  }
}
```

Do not gate the foreground response on the latest *started* topology token. A newer catalog request that has not successfully applied is not enough to discard the current foreground response.

- [ ] **Step 5: Let a validated catalog snapshot fulfill the matching context**

Immediately after `reconcileProjectCatalog()` applies `orderedSnapshot` through `applyProjectWorkspaceProjection()`, check the current pending selection:

```ts
const pending = this.pendingProjectSelection;
if (this.isPendingProjectSelectionCurrent(pending)
  && pending.machineId === orderedSnapshot.machineId
  && pending.project.id === orderedSnapshot.project.id
  && pending.project.path === orderedSnapshot.project.path) {
  await this.completePendingProjectSelection(pending, orderedSnapshot.workspaces, {
    machineId: orderedSnapshot.machineId,
    project: orderedSnapshot.project,
    topologyRequest,
  });
  return;
}
```

Keep this after topology validation/application and before generic discovered-workspace hydration. That lets the fresh snapshot satisfy the original route target without duplicate initial session hydration.

- [ ] **Step 6: Run the focused controller test file and verify green**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts
```

Expected: all `WorkspaceController` tests pass, including the three new foreground/catalog race regressions.

- [ ] **Step 7: Perform only local readability cleanup, then rerun the focused file**

Keep any cleanup limited to naming or duplication around the new context helpers. Keep the public `WorkspaceController` surface unchanged. Re-run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts
npm run typecheck
npx eslint src/client/src/controllers/workspaceController.ts src/client/src/controllers/workspaceController.test.ts
```

Expected: all commands exit successfully.

- [ ] **Step 8: Commit the correction and its regression coverage**

```bash
git add src/client/src/controllers/workspaceController.ts src/client/src/controllers/workspaceController.test.ts
git commit -m "fix(workspaces): preserve newer catalog topology"
```

### Task 3: Record the user-facing correction and regenerate the release candidate

**Files:**
- Create: `.changeset/foreground-project-selection-topology-freshness.md`
- Modify: generated `CHANGELOG.md`, `package.json`, `package-lock.json`
- Delete: five consumed `.changeset/*.md` fragments during versioning

**Interfaces:**
- Consumes: the restored `1.10.2` package metadata and five patch-level Changesets.
- Produces: a regenerated `1.10.3` release candidate whose package and lockfile versions match and whose changelog includes the correction.

- [ ] **Step 1: Add the patch Changeset**

Create `.changeset/foreground-project-selection-topology-freshness.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Keep live worktree and spawned-session discovery from reverting to stale project topology while a project load is pending.
```

- [ ] **Step 2: Verify the complete focused regression suite before versioning**

Run:

```bash
npm test -- --run src/client/src/controllers/workspaceController.test.ts src/server/memory/piHermesMemoryProvider.test.ts src/server/memory/memoryService.test.ts src/server/memory/memoryRoutes.test.ts src/client/src/sessionTreeRows.search.test.ts src/client/src/sessionSearch.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionBrowserDialog.test.ts
npm run changelog:status
```

Expected: all focused suites pass and Changesets reports one patch package bump.

- [ ] **Step 3: Commit the Changeset**

```bash
git add .changeset/foreground-project-selection-topology-freshness.md
git commit -m "chore: add topology freshness changeset"
```

- [ ] **Step 4: Regenerate exact `v1.10.3` metadata**

Run:

```bash
npm run release:version
npm install --package-lock-only
node -e "const v=require('./package.json').version, l=require('./package-lock.json'); if (v !== '1.10.3' || l.version !== v || l.packages[''].version !== v) { console.error({ package: v, lock: l.version, root: l.packages[''].version }); process.exit(1); } console.log('lockfile in sync at', v);"
```

Review the generated `CHANGELOG.md` section. It must contain all five user-facing patch notes and show `## 1.10.3`; do not create a local Git tag.

- [ ] **Step 5: Run release-quality validation against the regenerated candidate**

Run sequentially:

```bash
npm run verify
npm run build
npm run pack:dry
git diff --check
git status --short --branch
```

Expected: all commands exit successfully, package dry-run names `@hyperdreamer/pi-webui@1.10.3`, and the working diff contains only intended release metadata plus consumed Changesets.

- [ ] **Step 6: Commit the regenerated release metadata**

```bash
git add package.json package-lock.json CHANGELOG.md .changeset
git commit -m "chore(release): v1.10.3"
```

- [ ] **Step 7: Request a fresh read-only review and repeat the security gate**

Review the implementation range from `v1.10.2` through the new release-candidate SHA. Resolve Critical and Important findings before publishing.

Create a new ignored release handoff under `.superpowers/sdd/release-v1.10.3/` tied to the new candidate SHA. Re-run all `IGNORED.md` requirements:

```bash
npm audit --omit=dev --json
npm audit --include=dev --json
npm ls @earendil-works/pi-coding-agent minimatch brace-expansion --all
npm explain brace-expansion
npm pack --dry-run --ignore-scripts --json
npm view @earendil-works/pi-coding-agent versions --json
npm view @earendil-works/pi-coding-agent@0.82.1 dist --json
```

Retain the exact audit outputs, package provenance, shrinkwrap comparison, candidate diff/secret review, review date, and policy expiry. Do not create the GitHub Release until the user/PM explicitly approves the documented exception for the new candidate SHA and the final security recheck records **PASS WITH DOCUMENTED EXCEPTION**.

- [ ] **Step 8: Publish only through the existing GitHub Actions workflow after all gates**

Follow `.agents/skills/npm-release-via-github-actions/SKILL.md`:

```bash
git push origin main
gh release create v1.10.3 --target main --title "v1.10.3" --notes-file /tmp/pi-webui-release-notes-v1.10.3.md
gh run list --workflow publish.yml --limit 5
gh run watch <run-id>
npm view @hyperdreamer/pi-webui@1.10.3 dist.tarball
```

Do not run local `npm publish`.

## Plan self-review checklist

- **Spec coverage:** Task 1 proves stale success, same-ID/path replacement, and stale error behavior; Task 2 gives one private ownership boundary and one completion path; Task 3 records the patch, revalidates the package, security gate, and GitHub Actions-only publication.
- **Type consistency:** `PendingProjectSelection` contains `RouteTarget | undefined`; catalog fulfillment passes `CatalogWorkspaceSelectionScope`; foreground fulfillment omits it deliberately.
- **Scope:** No server/session-daemon or app-URL changes are introduced. Existing generic catalog hydration/fallback behavior runs unchanged when no foreground selection is pending.
- **Placeholder scan:** The plan contains no unfinished markers or unspecified validation step.
