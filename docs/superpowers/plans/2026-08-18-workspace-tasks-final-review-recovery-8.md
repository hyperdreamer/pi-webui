# Workspace Tasks Final Review Recovery 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Build an admissible final-review handoff for the committed Workspace Tasks feature and complete a correctly addressed Frontier final review.

**Architecture:** One no-source-change audit task verifies the exact product source baseline and documentation-only recovery range, checks the admitted recovery-6 task evidence while excluding all mismatched final-review children, runs remaining package checks, and creates a fresh final-review package and ledger for a fresh task reviewer and final reviewer.

**Tech Stack:** Git, Node.js 22.19+, existing PI WEBUI verification scripts, Changesets, deterministic SDD controller.

## Global Constraints

- The approved design in `docs/superpowers/specs/2026-08-18-workspace-tasks-final-review-recovery-8-design.md` and the Workspace Tasks design remain authoritative.
- Preserve recovery-3 through recovery-7 run roots unchanged; do not use recovery-6 final-review output, recovery-7 audit output, or any mismatched child output as evidence.
- Treat `b78bb44f0cb68ff4cfcc8b930af787263d665144` as the exact product source baseline, `792f044f22f70792c9826f473f4af17786e9dc33` as the exact current final HEAD, `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb4` as the source-only baseline, and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- The final review range is `5eda56bbab1c295e04623ed156039c3ddc847072..792f044f22f70792c9826f473f4af17786e9dc33` and must contain only approved documentation/recovery control files; the product source range ends at `b78bb44f0cb68ff4cfcc8b930af787263d665144`.
- The recovery-6 Task 1 implementer and task-review reports are admitted; verify their paths and approval. Do not read or use recovery-6 final-review output or recovery-7 audit output.
- Do not modify shipped source or tests, add dependencies, change session-daemon code/protocol, or change runtime ownership.
- Every child prompt must be rendered to a file, stored in its dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.
- Do not merge, push, publish, tag, release, or create an empty product commit.

## Task 1: Rebuild Correct Final Review Handoff

**Implementer tier:** Capable

**Files:**

- Create only recovery-8 run-root reports, packages, ledger, and prompt artifacts.
- Modify no shipped source, tests, documentation, package metadata, or Git history.

**Interfaces:**

- Consumes the exact product source baseline/range and admitted recovery-6 Task 1 report/review.
- Produces a fresh final-review package, explicit empty findings ledger, audit report, and evidence for the task reviewer and final reviewer.

- [ ] **Step 1: Verify identity and evidence boundaries**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --check
git diff --name-only 04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb..HEAD
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Require `HEAD` to equal `792f044f22f70792c9826f473f4af17786e9dc33`, the product source baseline `b78bb44f0cb68ff4cfcc8b930af787263d665144` to be its ancestor, and the only source/test changes in the final range to be none. Verify recovery-6 Task 1 is accepted with `TASK_COMPLETE`, its task review is `SPEC: PASS` and `QUALITY: APPROVED`, and no admitted final-review report exists. Do not read recovery-6 final-review output or recovery-7 audit output.

- [ ] **Step 2: Run checks and create the fresh final package**

Run serially:

```bash
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Confirm dry-pack contains the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML pages remain repository-only. Copy only the admitted recovery-6 Task 1 report and task-review report into the fresh package with SHA-256 hashes. Add the exact range diff, the recovery-8 plan, and an empty findings ledger. The package must explicitly mark recovery-6 final-review and recovery-7 audit outputs inadmissible.

- [ ] **Step 3: Write the audit report**

Write exactly one report with final HEAD `792f044`, product baseline `b78bb44`, exact range, admitted evidence hashes, command outcomes, package contents, Changeset status, clean worktree, and no product commit. Return exactly one implementer status.
