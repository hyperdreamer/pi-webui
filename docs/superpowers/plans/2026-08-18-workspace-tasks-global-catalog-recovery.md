# Workspace Tasks Verification Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Produce fresh, admissible Chromium/CDP and complete-branch verification for Workspace Tasks after the original Task 15 dispatch mismatch.

**Architecture:** Preserve the original terminal run and carry forward only committed source through `da1463cce69a50199ff17835e765d89b4e30913d`. A single verification task independently repeats browser acceptance and all required checks without using the mismatched child's evidence; a fresh task reviewer and whole-branch Frontier final reviewer provide the remaining gates.

**Tech Stack:** TypeScript, Vitest, Lit custom elements, Chromium DevTools Protocol, Node.js 22.19+, Changesets.

## Global Constraints

- The recovery design in `docs/superpowers/specs/2026-08-18-workspace-tasks-global-catalog-recovery-design.md` and the approved original design in `docs/superpowers/specs/2026-08-16-workspace-tasks-global-catalog-design.md` are authoritative.
- Preserve the original `.sdd/workspace-tasks-global-catalog` run root byte-for-byte; it remains terminal at `DISPATCH_MISMATCH_BLOCKED` revision 221.
- Treat `da1463cce69a50199ff17835e765d89b4e30913d` as the committed product baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the complete feature-range base.
- Do not read or use the mismatched Task 15 child transcript, report, browser output, status, or probe artifacts as evidence. Establish every verification result independently in this run.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Keep workspace task storage at `<workspace>/.pi-webui/tasks.json`; user-facing copy says Project, while internal persistence keys and routes say workspace.
- Keep task file schema version 1 and represent scope only through `WorkspaceTaskRef`, never a task-object scope field.
- Keep `src/plugin-api.ts`, `README.md`, `CHANGELOG.md`, session-daemon code, protocol, and runtime ownership unchanged.
- Use application-relative browser paths, encode dynamic path segments, and resolve URLs exactly once at the browser boundary.
- Do not add a durable move journal, automatic retries, automatic compensation, silent merges, or cross-process locking claims.
- Use temporary or `/tmp` browser fixtures only; remove every probe artifact before reporting.
- Do not modify source or tests unless a fresh Chromium/CDP measurement proves a defect. For any measured defect, add a deterministic regression, observe RED against the current implementation, make the minimum fix, observe GREEN, and repeat the same browser measurement.
- Run full verification serially on an otherwise idle machine and report exact commands and outcomes.
- Do not merge, push, publish, tag, or create a GitHub release.

## Task 1: Repeat Browser Acceptance And Complete-Branch Verification

**Implementer tier:** Advanced

**Files:**

- Create temporarily, then remove before completion: an ignored or `/tmp` Workspace Tasks Chromium/CDP probe fixture and its output.
- Modify only if a fresh measured defect requires it: `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts`.
- Modify only with the corresponding deterministic RED/GREEN regression: `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts`.

**Interfaces:**

- Consumes the committed Workspace Tasks feature range `5eda56bbab1c295e04623ed156039c3ddc847072..da1463cce69a50199ff17835e765d89b4e30913d`, the original approved design, and the current real bundled panel/controller bridge.
- Produces a report containing independently observed focused-test results, Chromium/CDP measurements at desktop and `430x844`, classic/light/dark theme coverage, final full-verification results, final HEAD, and clean-worktree evidence.
- Produces no shipped fixture and no commit when the current implementation passes. If a fresh measured defect is fixed, produces only the behavior-specific source/test commit allowed above.

- [ ] **Step 1: Establish the clean source baseline**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Require a clean worktree before creating temporary probe files. Confirm the feature range contains the expected Workspace Tasks implementation and documentation, while `README.md`, `CHANGELOG.md`, `src/plugin-api.ts`, and session-daemon ownership/protocol files are unchanged. Do not consult the blocked Task 15 transcript, report, or probe artifacts.

- [ ] **Step 2: Run focused cross-layer regression suites**

Run serially, without another full suite or browser probe competing for resources:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
```

Record exact file/test counts and failures. Do not begin browser acceptance until both commands exit zero.

- [ ] **Step 3: Run a fresh Chromium/CDP acceptance probe**

Use `/usr/bin/chromium` and raw CDP with a temporary user-data directory and free debugging port. Mount the real built Workspace Tasks custom element with typed controller state/actions and deterministic catalogs. Do not use a source copy from the blocked run.

At desktop and `430x844`, record panel/document `scrollWidth` and `clientWidth`, details summary/body bounds, action wrapping, long-script bounds and vertical overflow, visible `:focus-visible` outline, duplicate-ID action accessible names, `aria-pressed` filter state, native disclosure persistence, focus return after cancel/confirm, and keyboard Tab/Escape/Enter behavior. Exercise equal Global/Project IDs, promotion, demotion, destination collision, partial recovery, and guarded Retry. Inspect classic, light, and dark tokens. Treat hidden controls in collapsed native disclosures as non-interactable and open the relevant disclosure before user-input measurements.

- [ ] **Step 4: Fix only a defect reproduced by the fresh probe**

If Chromium measures a shipped defect, add the narrowest deterministic component regression first and run it against the current implementation to prove RED for the measured mechanism. Apply the minimum panel source change, rerun the regression and focused panel suite to prove GREEN, rebuild the plugin, and rerun the identical CDP measurement.

If the probe fixture itself is wrong, correct or discard the temporary fixture without changing shipped source. Compare against the unchanged committed implementation when needed to distinguish a fixture defect from a product defect.

- [ ] **Step 5: Remove temporary artifacts and inspect scope**

Remove the temporary server, Chromium profile, screenshots, scripts, and probe output. Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

No probe artifact may be tracked or remain in the worktree. If no product defect was measured, the source/test tree must still match `da1463cce69a50199ff17835e765d89b4e30913d` apart from the committed recovery specification and plan.

- [ ] **Step 6: Run complete verification in order**

On an otherwise idle machine, run one command at a time:

```bash
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Require every command to exit zero. Confirm `pack:dry` includes the compiled Workspace Tasks plugin, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`; paired HTML documentation is intentionally not packaged.

- [ ] **Step 7: Commit only a measured fix and report**

If Step 4 changed source/tests, commit exactly the measured files with a behavior-specific Conventional Commit message after focused and full verification. Otherwise create no empty verification commit. Write the implementation report with exact commands, Chromium availability, viewport and theme measurements, defect/fixture decisions, final HEAD, worktree status, and the fact that blocked-run Task 15 evidence was not used.
