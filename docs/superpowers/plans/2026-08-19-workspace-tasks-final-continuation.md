# Workspace Tasks Final Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this plan task-by-task.

**Goal:** Independently audit the verified Workspace Tasks product range and complete task and Frontier final review.

**Architecture:** Existing Workspace Tasks adapters, move registry/service, route composition, and bundled panel remain the ownership boundaries. Task 1 is audit-only; any load-bearing review finding enters the normal bounded fix loop.

**Tech Stack:** TypeScript, Fastify, Lit custom elements, Vitest, Node.js 22.19+.

## Global Constraints

- Whole product range under review: `5eda56bbab1c295e04623ed156039c3ddc847072..10e49a568de80ad049dcb5074e421846b313635d`.
- Remediation range under review: `de2e1dd67048179f33c20d67adf9ddb8a86037e8..10e49a568de80ad049dcb5074e421846b313635d`.
- Do not use predecessor blocked child reports as correctness evidence; inspect Git and run fresh verification.
- Preserve Workspace Tasks version-one schema, storage path, route/API contracts, CAS behavior, move recovery behavior, panel draft retention, and public plugin contracts.
- Do not modify `src/plugin-api.ts`, session-daemon code/protocol, runtime ownership, `README.md`, `CHANGELOG.md`, release metadata, dependencies, or unrelated source.
- Work only in `/data/home/guest/Development/pi-webui/.worktrees/workspace-tasks-global-catalog-final-continuation`.
- Every tracked child prompt must be rendered and persisted before dispatch; dispatch uses the exact persisted bytes, and the first child message must be compared byte-for-byte before admission.

## Task 1: Audit Verified Workspace Tasks Range

**Implementer tier:** Capable

**Files:**

- Read-only audit of `5eda56bbab1c295e04623ed156039c3ddc847072..10e49a568de80ad049dcb5074e421846b313635d`.
- Read-only audit of the Workspace Tasks implementation and focused regressions.
- Create only per-run SDD artifacts under the run root.

**Interfaces:**

- The audit report records exact source scope, test/build/package evidence, and any environment limitations.
- The task reviewer independently verifies the complete product range and all finding contracts.
- Final review runs at Frontier over the whole range and may open the single final-fix wave only for a newly identified load-bearing defect.

- [ ] **Step 1: Verify identity and scope**

Confirm clean status, exact HEAD, ancestor/base relationships, diff checks, and changed-file projections. Verify protected paths and the original Workspace Tasks contracts. Do not edit source.

- [ ] **Step 2: Run complete verification**

Run the focused Workspace Tasks tests, `npm run typecheck`, scoped lint, `npm run verify`, `npm run build`, `npm run pack:dry`, `npm run changelog:status`, and `git diff --check` from the continuation worktree. Record exact results.

- [ ] **Step 3: Report audit**

Write exactly one implementer report with `STATUS: DONE`, no commit, and no product changes. Include the full range, protected-file result, tests, and package checks.

- [ ] **Step 4: Independent task review**

Dispatch a Frontier task reviewer against the exact whole product range. Require `SPEC: PASS` and `QUALITY: APPROVED` with no open load-bearing findings before task completion. Use the bounded fix loop if necessary.

- [ ] **Step 5: Frontier final review**

Dispatch a fresh Frontier final reviewer over the whole product range and all Workspace Tasks contracts. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, a reconciled empty finding ledger, clean Git state, and audit status `OK`.
