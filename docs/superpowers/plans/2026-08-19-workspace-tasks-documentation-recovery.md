# Workspace Tasks Documentation Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Independently audit the corrected Workspace Tasks documentation and complete fresh task and Frontier final review.

**Architecture:** The two prior mismatch-blocked runs remain immutable. This run audits the committed documentation correction and the complete Workspace Tasks range, then obtains independent task and final review without changing product source.

**Tech Stack:** Markdown/HTML documentation, TypeScript, Vitest, Node.js 22.19+, deterministic SDD controller.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- The post-mismatch run at `.sdd/workspace-tasks-post-mismatch-continuation-recovery` is terminal at `TASK_BLOCKED` revision 16 after a prompt-byte mismatch; do not use its fixer report, claimed correction, or verdict as evidence.
- The predecessor run at `.sdd/workspace-tasks-final-continuation-recovery` is terminal at `TASK_BLOCKED` revision 17 after its own prompt-byte mismatch; preserve it and do not use its fixer report or verdict as evidence.
- Treat commit `6ca0e6d` as source to inspect, not as a trusted report. The correction range is `92933dc785e06f21e855d647e55c6ce22ef349e7..6ca0e6d`; the complete Workspace Tasks range is `5eda56bbab1c295e04623ed156039c3ddc847072..6ca0e6d`.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- Every tracked child prompt must be rendered and persisted before dispatch. Dispatch only the exact persisted bytes, compare each child first user message byte-for-byte before admitting its report, and record receipts under this run root.
- A short file-backed bootstrap is authorized for the audit dispatch by the recovery ruling. It must name the complete brief/report paths, carry the typed tier label, and itself be the exact persisted dispatch prompt.

## Task 1: Audit Corrected Workspace Tasks Documentation

**Implementer tier:** Capable

**Files:**

- Read-only audit of `5eda56bbab1c295e04623ed156039c3ddc847072..6ca0e6d`.
- Read-only focused audit of `92933dc785e06f21e855d647e55c6ce22ef349e7..6ca0e6d`.
- Read-only inspection of Workspace Tasks controller/panel/server/docs changes and focused regressions.
- Create only per-run SDD artifacts beneath the new run root.

**Interfaces:**

- Consumes the exact pinned Git ranges, the Workspace Tasks design constraints, and the current branch tip.
- Produces exactly one audit report with source identity, protected-path scope, documentation-finding evidence, test/build/package evidence, and environmental limitations.
- Produces no product source, test, package, configuration, documentation, dependency, or Git-history change.
- The task reviewer independently judges the complete range and must report `SPEC: PASS` and `QUALITY: APPROVED` with no unresolved load-bearing findings before task completion.
- A fresh Frontier final reviewer independently judges the complete range after task completion. Completion requires `SPEC: PASS`, `QUALITY: APPROVED`, a reconciled empty ledger, clean Git state, and audit status `OK`.

- [ ] **Step 1: Verify identity and protected scope**

Confirm that `92933dc785e06f21e855d647e55c6ce22ef349e7` and `5eda56bbab1c295e04623ed156039c3ddc847072` are ancestors of `6ca0e6d`. Record branch, HEAD, status, changed-file projections, and `git diff --check` for both ranges and the working tree. Confirm the correction changes only `docs/config.md`, `docs/config.html`, and `src/workspaceTasksDocumentation.test.ts`, and that the complete range has no protected-path, session-daemon, runtime-ownership, dependency, release-metadata, README, or CHANGELOG change.

- [ ] **Step 2: Independently inspect the correction and surrounding behavior**

Read the paired configuration wording, the new documentation regression, the bundled Workspace Tasks panel controls, and the existing plugin documentation. Verify that malformed global data is repaired through normal configuration administration and then loaded with the implemented Refresh action; verify no Project-file reset control is documented by the corrected surfaces; and verify the regression normalizes HTML markup while checking both documents. Do not use either prior mismatched fixer report as evidence.

- [ ] **Step 3: Run fresh verification**

Run serially on an otherwise idle machine:

```text
npm test -- --run src/workspaceTasksDocumentation.test.ts src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts src/server/app.workspaceTasks.test.ts src/server/workspaceTasks src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts pi-webui-plugins/workspace-tasks scripts/build-plugins.test.mjs
npm run verify
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Record actual pass/fail results, package contents showing `docs/config.md`, and non-failing environmental warnings.

- [ ] **Step 4: Report the audit**

Write exactly one report with `STATUS: DONE` only if the audit and verification pass. Include full SHA ranges, changed files, protected-path result, exact command results, package checks, and the fact that both prior mismatch-blocked fixer reports and verdicts were excluded. Do not create a product commit.

- [ ] **Step 5: Review boundary**

After the audit report is admitted, dispatch a fresh Frontier task reviewer against the complete range. Require `SPEC: PASS` and `QUALITY: APPROVED` with no unresolved load-bearing findings. Then dispatch a fresh Frontier final reviewer over the complete range. Complete only with an empty reconciled finding ledger, clean Git state, and audit status `OK`.
