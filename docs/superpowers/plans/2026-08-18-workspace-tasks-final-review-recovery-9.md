# Workspace Tasks Final Review Recovery 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Rebuild an admissible final-review handoff and complete Frontier final review for the committed Workspace Tasks feature.

**Architecture:** A single no-source-change audit task records the observed continuation HEAD, proves the product source/test projection remains unchanged from `b78bb44`, verifies admitted recovery-6 task evidence, runs package checks, and builds a fresh final-review package and ledger for independent task and final review.

**Tech Stack:** Git, Node.js 22.19+, existing PI WEBUI verification scripts, Changesets, deterministic SDD controller.

## Global Constraints

- The approved design in `docs/superpowers/specs/2026-08-18-workspace-tasks-final-review-recovery-9-design.md` and the Workspace Tasks design remain authoritative.
- Preserve recovery-3 through recovery-8 run roots unchanged; do not use recovery-6 final-review output, recovery-7 audit output, or recovery-8 blocked-child output as evidence.
- Treat `b78bb44f0cb68ff4cfcc8b930af787263d665144` as the immutable product source baseline and `5eda56bbab1c295e04623ed156039c3ddc847072` as the whole feature-range base.
- Record the observed current HEAD and prove the source/test projection from `b78bb44f0cb68ff4cfcc8b930af787263d665144..HEAD` is empty; continuation documents are allowed in the final range.
- The recovery-6 Task 1 implementer and task-review reports are admitted; verify their paths and approval. All later final-review/audit/blocked-child outputs are inadmissible.
- Do not modify shipped source or tests, add dependencies, change session-daemon code/protocol, or change runtime ownership.
- Every child prompt must be rendered to a file, stored in its dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.
- Do not merge, push, publish, tag, release, or create an empty product commit.

## Task 1: Rebuild Final Review Handoff Without Source Changes

**Implementer tier:** Capable

**Files:**

- Create only recovery-9 run-root reports, packages, ledger, and prompt artifacts.
- Modify no shipped source, tests, documentation, package metadata, or Git history.

**Interfaces:**

- Consumes the product baseline, observed current HEAD, and admitted recovery-6 Task 1 report/review.
- Produces a fresh final-review package, explicit empty findings ledger, audit report, and evidence for fresh task/final reviewers.

- [ ] **Step 1: Verify source identity and admitted evidence**

Run:

```bash
git status --short
git rev-parse HEAD
git merge-base --is-ancestor b78bb44f0cb68ff4cfcc8b930af787263d665144 HEAD
git diff --check
git diff --name-only b78bb44f0cb68ff4cfcc8b930af787263d665144..HEAD
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Require a clean worktree, the product baseline as an ancestor, and no source/test paths in the product-baseline-to-HEAD projection. Record the observed HEAD and exact documentation-only paths. Verify recovery-6 Task 1 is accepted with `TASK_COMPLETE`, its task review says `SPEC: PASS` and `QUALITY: APPROVED`, and its final-review report is absent. Do not use recovery-6 final-review, recovery-7, or recovery-8 child outputs.

- [ ] **Step 2: Run package checks and create the fresh final package**

Run serially:

```bash
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Confirm dry-pack contains the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML pages remain repository-only. Copy only the admitted recovery-6 Task 1 report and task-review report into the recovery-9 final package with SHA-256 hashes. Add the exact observed HEAD/range diff, the recovery-9 plan, and an empty findings ledger. Explicitly mark all later mismatched outputs inadmissible.

- [ ] **Step 3: Write the audit report**

Write exactly one report with product baseline, observed HEAD, exact source/test projection, admitted evidence hashes, command outcomes, package contents, Changeset status, clean worktree, and no product commit. Return exactly one implementer status.
