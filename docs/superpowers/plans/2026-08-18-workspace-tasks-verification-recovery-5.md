# Workspace Tasks Verification Recovery 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Produce fresh browser acceptance, full serial verification, package evidence, and cleanup for the committed Workspace Tasks feature without relying on any predecessor run.

**Architecture:** One fresh Capable task owns a new raw-CDP fixture, full interaction matrix, serial test/build/package verification, and temporary-artifact cleanup. The existing feature source is changed only for a fresh measured product defect that follows RED/GREEN verification; predecessor evidence is sealed and excluded.

**Tech Stack:** TypeScript, Lit custom elements, Node.js 22.19+, Vitest, Chromium DevTools Protocol, Changesets.

## Global Constraints

- The approved recovery design in `docs/superpowers/specs/2026-08-18-workspace-tasks-verification-recovery-5-design.md` and the approved Workspace Tasks design are authoritative.
- Preserve recovery-3 and recovery-4 SDD run roots unchanged; do not read or use their reports, transcripts, browser artifacts, temporary fixtures, or result logs as evidence.
- Treat `731aa47afad200413ccbd7ef670ff9314d1780b4` as the exact recovery source baseline, `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` as the source-only baseline, and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- Use only `/tmp/workspace-tasks-cdp-recovery-5` for temporary browser assets. Do not read `/tmp/workspace-tasks-cdp-recovery-3` or `/tmp/workspace-tasks-cdp-recovery-4`.
- Node.js 22.19 is the minimum supported runtime; add no runtime dependencies.
- Keep `src/plugin-api.ts`, `README.md`, `CHANGELOG.md`, session-daemon code/protocol, and runtime ownership unchanged unless a fresh browser measurement proves a shipped panel defect and the task RED/GREEN rule is followed.
- Use raw CDP only with a `type: page` target discovered from the newly spawned Chromium process. Use dynamic HTTP and DevTools ports and a temporary Chromium profile.
- Every child prompt must be rendered to a file, stored in its dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.
- Do not merge, push, publish, tag, release, or change the session daemon.

## Task 1: Fresh Browser Acceptance, Serial Verification, And Cleanup

**Implementer tier:** Capable

**Files:**

- Create temporarily, then delete before reporting: `/tmp/workspace-tasks-cdp-recovery-5/fixture.html`.
- Create temporarily, then delete before reporting: `/tmp/workspace-tasks-cdp-recovery-5/probe.mjs`.
- Create temporarily, then delete before reporting: `/tmp/workspace-tasks-cdp-recovery-5/acceptance.mjs`.
- Modify only `pi-webui-plugins/workspace-tasks/tasksPanelElement.ts` and one corresponding deterministic regression in `pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts` or `pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts` if a fresh Chromium measurement proves a shipped defect.

**Interfaces:**

- Consumes the current generated Workspace Tasks panel and no predecessor evidence.
- Produces a fresh strict fixture, raw-CDP smoke/acceptance runners, browser evidence for all six viewport/theme cells, exact serial verification results, package/changelog evidence, cleanup proof, and one implementer report.

- [ ] **Step 1: Establish a clean source baseline and a falsifiable fixture RED**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --check
git merge-base --is-ancestor 731aa47afad200413ccbd7ef670ff9314d1780b4 HEAD
git merge-base --is-ancestor 04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb HEAD
git diff --name-only 04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb..HEAD
npm run build:plugins
```

Require the source/test projection from `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` to `HEAD` to be empty and later paths to be recovery documents only. Do not inspect predecessor artifacts. Create the recovery-5 temporary root only after this check. Write a minimal raw-CDP probe first, run it before `fixture.html` exists, and record the expected missing-fixture RED. Build the fixture from scratch with a strict generated-module allowlist, dynamic HTTP/DevTools ports, a temporary profile, page-target discovery through `/json/list`, Runtime/Page enablement, and `finally` cleanup for every browser/server/profile/result path.

- [ ] **Step 2: Run fresh browser smoke and complete acceptance matrix**

Mount the real custom element with controller-shaped context, state, and actions. Expose helpers for canonical Classic/Dark/Light application, catalog publication, scope filters, native details groups, scoped duplicate action lookup, promotion, demotion, collision, partial/unknown/manual recovery, guarded Retry, focus snapshots, and keyboard input. At `1280x900` and `430x844` for each of the three themes, assert the qualified root theme identity, color scheme, and canonical relevant token values; panel/document `scrollWidth` equals `clientWidth`; summary/body/action bounds remain in viewport; action wrapping is stable; long commands have bounded internal vertical overflow; focus-visible outline is measurable; filters use correct `aria-pressed`; disclosure state persists; duplicate IDs have independent accessible names; promotion/demotion/collision/recovery paths preserve their contracts; Tab/Escape/Enter return focus correctly; and terminal metadata retains scoped task identity. Separately force spawn, nonexistent-binary, and early-exit startup failures and prove each removes its profile and leaves no matching process. Classify HTTP content/status, target identity, page exceptions, and fixture assertions separately.

- [ ] **Step 3: Apply only a measured shipped correction**

If and only if the matrix proves a product defect in `tasksPanelElement.ts`, add the smallest deterministic regression and observe RED against the current source. Make the minimum source/test change, run the focused regression GREEN, rebuild plugins, repeat the identical browser measurement, inspect the exact diff, and commit only that measured fix. Correct fixture or runner defects only under `/tmp/workspace-tasks-cdp-recovery-5` and retain no temporary result log.

- [ ] **Step 4: Run all verification commands serially**

Run one command at a time on an otherwise idle machine:

```bash
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts scripts/build-plugins.test.mjs src/client/src/api/http.test.ts src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts src/client/src/plugins/registry.test.ts pi-webui-plugins/pluginPublicApi.test.ts pi-webui-plugins/workspace-tasks/config.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.test.ts pi-webui-plugins/workspace-tasks/tasksPanelElement.editor.test.ts pi-webui-plugins/workspace-tasks/taskRunner.test.ts pi-webui-plugins/workspace-tasks/pi-webui-plugin.test.ts
npm run test:serial -- --run src/config.test.ts src/configMutationCoordinator.test.ts src/server/workspaceTasks src/server/app.workspaceTasks.test.ts src/server/app.localAliases.test.ts src/server/app.workspaceFiles.test.ts src/server/app.remoteProxy.test.ts
npm run verify:fast
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Record exact exit status and test counts. Confirm `pack:dry` contains the compiled Workspace Tasks plugin, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML documentation remains repository-only. Do not hide a failed command or substitute predecessor results.

- [ ] **Step 5: Remove artifacts and report**

Remove `/tmp/workspace-tasks-cdp-recovery-5/`, every profile/result/log/process it created, and any dry-pack artifact. Run:

```bash
git status --short
git diff --check
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Confirm protected files remain unchanged, no empty verification commit exists, and all temporary artifacts are gone. Write exactly one report with fresh browser identity/measurements, all command outcomes, package and Changeset evidence, final HEAD, exact scope, and cleanup proof.
