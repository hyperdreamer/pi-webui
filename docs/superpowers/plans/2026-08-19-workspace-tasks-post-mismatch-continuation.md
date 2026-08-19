# Workspace Tasks Post-Mismatch Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Independently audit the carried-forward Workspace Tasks correction and complete fresh task and Frontier final review without admitting evidence from the prompt-mismatched fixer.

**Architecture:** The prompt-mismatched predecessor run is terminal and immutable. Its committed source is a candidate, not certified work: a new audit reads the exact Git ranges, runs fresh verification, and creates no product changes. A fresh task reviewer then judges the full candidate range; only newly confirmed load-bearing findings may use the normal bounded fix loop before the required Frontier final review.

**Tech Stack:** TypeScript, Fastify, Lit custom elements, Vitest, Node.js 22.19+.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Candidate carried-forward fix: `8fca9efac231baf262294462ff4ce5b09001ff9e..74167faa843e46ed008c5bb2838cfc49d35fa278`.
- Full Workspace Tasks product range for independent review: `5eda56bbab1c295e04623ed156039c3ddc847072..74167faa843e46ed008c5bb2838cfc49d35fa278`.
- The predecessor run at `.sdd/workspace-tasks-final-continuation-recovery` is terminal after its correlated fixer received 5,256 bytes instead of its stored 6,257-byte prompt. Do not use that fixer's report, claimed tests, verdict, or rationale as correctness evidence; inspect Git and run fresh verification.
- Treat commit `74167faa843e46ed008c5bb2838cfc49d35fa278` as source to inspect, not as a trusted report. Preserve predecessor run roots, prompts, reports, receipts, state files, and progress ledgers unchanged.
- Preserve Workspace Tasks version-one schema, `<workspace>/.pi-webui/tasks.json`, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- Every tracked child prompt must be rendered and persisted before dispatch. Dispatch only the exact persisted bytes, compare the first child user message byte-for-byte before report admission, and record the comparison receipt under the new run root.
- Use a short persisted file-backed bootstrap only when a recovery ruling records why it is needed. The bootstrap must name the complete brief/report paths, carry the typed tier label, and be itself the exact persisted dispatch prompt.

## Task 1: Audit Carried-Forward Workspace Tasks Fix

**Implementer tier:** Capable

**Files:**

- Read-only audit of `5eda56bbab1c295e04623ed156039c3ddc847072..74167faa843e46ed008c5bb2838cfc49d35fa278`.
- Read-only focused audit of `8fca9efac231baf262294462ff4ce5b09001ff9e..74167faa843e46ed008c5bb2838cfc49d35fa278`.
- Read-only inspection of Workspace Tasks client controller/panel/docs changes and focused regressions.
- Create only per-run SDD artifacts beneath the new run root.

**Interfaces:**

- Consumes the exact candidate ranges, the pre-existing Workspace Tasks version-one/public-contract constraints, and Git state at the continuation branch tip.
- Produces exactly one implementer report that records source identity, protected-path scope, test evidence, package evidence, and environmental limitations.
- Produces no product source, test, package, configuration, documentation, dependency, or Git-history change.
- The task reviewer independently judges the whole product range and must report `SPEC: PASS` and `QUALITY: APPROVED` with no unresolved load-bearing findings before task completion.
- A fresh Frontier final reviewer independently judges the whole candidate range after task review completion. Completion requires `SPEC: PASS`, `QUALITY: APPROVED`, a reconciled empty ledger, clean Git state, and audit status `OK`.

- [ ] **Step 1: Verify identity and protected scope**

Confirm that `8fca9efac231baf262294462ff4ce5b09001ff9e` is an ancestor of `74167faa843e46ed008c5bb2838cfc49d35fa278`, and that `5eda56bbab1c295e04623ed156039c3ddc847072` is an ancestor of that same candidate. Record current branch `HEAD`, candidate commit, working-tree status, changed-file projections, and `git diff --check` for both ranges. Confirm the candidate range changes only the adjudicated controller/panel/docs paths and their focused tests; confirm the whole range has no protected-path, session-daemon, runtime-ownership, dependency, release-metadata, README, or CHANGELOG change.

- [ ] **Step 2: Independently inspect behavior and regression coverage**

Read the candidate diff and its focused tests directly. Verify that the controller prevents repeated ordinary retry after a failed source load while allowing explicit refresh/selection retry; mutation locks isolate workspace cache identities while serializing machine-global and move operations; empty/missing catalogs show retained refresh errors; and Markdown/HTML plugin docs describe only implemented invalid-file recovery behavior. Check these assertions against surrounding Workspace Tasks cache, CAS, move-recovery, panel draft-retention, route, and plugin-boundary code rather than repeating predecessor reports.

- [ ] **Step 3: Run fresh verification**

Run the focused Workspace Tasks family with:

```text
npm test -- --run src/shared/workspaceTasks.test.ts src/shared/workspaceTasksApi.test.ts src/server/app.workspaceTasks.test.ts src/server/workspaceTasks src/client/src/api/workspaceTasksApi.test.ts src/client/src/controllers/workspaceTasksController.test.ts src/client/src/components/PiWebUiApp.workspaceTasks.test.ts pi-webui-plugins/workspace-tasks scripts/build-plugins.test.mjs
```

Then run `npm run typecheck`, scoped ESLint covering every Workspace Tasks candidate file, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, and `git diff --check` for both audit ranges and the working tree. Record actual pass/fail results and relevant pre-existing non-failing warnings; do not state expected test counts as requirements.

- [ ] **Step 4: Report the audit**

Write exactly one report with `STATUS: DONE` only if the audit and verification pass. Include full SHA ranges, candidate changed files, protected-path result, exact commands/results, package checks, and any environmental limitation. State that the report independently inspected Git and did not use the predecessor terminal run's child report, claimed tests, or verdict. Do not create a product commit.

- [ ] **Step 5: Commit boundary**

Do not create a commit for this audit. Inspect `git status --porcelain` and the exact range diff before reporting; the only permitted outputs are ignored per-run artifacts. Return one role-contract status token.
