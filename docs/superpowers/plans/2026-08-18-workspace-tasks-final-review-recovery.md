# Workspace Tasks Final Review Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** Rebuild an admissible final-review handoff and complete the Frontier final review for the committed Workspace Tasks feature.

**Architecture:** One no-source-change audit task verifies the exact committed range and the admitted recovery-6 verification result, then creates a fresh final-review package and ledger under the new run root. A fresh task reviewer and a fresh Frontier final reviewer consume only those recovery-7 artifacts.

**Tech Stack:** Git, Node.js 22.19+, existing PI WEBUI verification scripts, Changesets, deterministic SDD controller.

## Global Constraints

- The approved design in `docs/superpowers/specs/2026-08-18-workspace-tasks-final-review-recovery-design.md` and the Workspace Tasks design remain authoritative.
- Preserve recovery-3, recovery-4, recovery-5, and recovery-6 run roots unchanged; do not use recovery-6 final-review child output as evidence.
- Treat `5eda56bbab1c295e04623ed156039c3ddc847072` as the merge base and `b78bb44f0cb68ff4cfcc8b930af787263d665144` as the exact final source HEAD.
- The recovery-6 Task 1 implementer and task-review reports are admitted; verify their paths, statuses, and clean-source claims independently. The recovery-6 final-review prompt and child transcript are inadmissible.
- Do not modify shipped source or tests, add dependencies, change session-daemon code/protocol, or change runtime ownership.
- Use only recovery-7 run-root artifacts for this continuation. Do not use predecessor temporary browser roots as evidence.
- Every child prompt must be rendered to a file, stored in its dispatch intent, and compared byte-for-byte with the child first message before its report is admitted.
- Do not merge, push, publish, tag, release, or create an empty product commit.

## Task 1: Rebuild Final Review Handoff Without Source Changes

**Implementer tier:** Capable

**Files:**

- Create only recovery-7 run-root reports, packages, ledger, and prompt artifacts.
- Modify no shipped source, tests, documentation, package metadata, or Git history.

**Interfaces:**

- Consumes the exact committed range and the admitted recovery-6 Task 1 report/review only.
- Produces a fresh final-review package, an explicit empty findings ledger, a final-review report handoff, and one audit report at the Dispatch Context path.

- [ ] **Step 1: Verify source identity and evidence boundaries**

Run:

```bash
git status --short
git rev-parse HEAD
git diff --check
git diff --stat 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
git diff --name-only 5eda56bbab1c295e04623ed156039c3ddc847072..HEAD
```

Require `HEAD` to equal `b78bb44f0cb68ff4cfcc8b930af787263d665144`, a clean worktree, and the expected documentation-only committed range. Verify the recovery-6 state is at its accepted Task 1 completion before the inadmissible final-review dispatch, its Task 1 report says `DONE_WITH_CONCERNS` only with the documented observational `verify:fast` concern, and its task-review report says `SPEC: PASS` and `QUALITY: APPROVED`. Confirm no recovery-6 final-review report exists. Do not read recovery-6’s final-review child output or predecessor browser artifacts.

- [ ] **Step 2: Rebuild the final package and run remaining checks**

Copy the immutable approved recovery-6 Task 1 report and task-review report into the recovery-7 final-review package with their source paths and SHA-256 hashes. Add the exact Git range package, the approved Workspace Tasks design/spec references, a fresh empty findings ledger, and the recovery-6 verify:fast observation with its serial/full-suite resolution. Run serially:

```bash
npm run build
npm run pack:dry
npm run changelog:status
git diff --check
```

Confirm the package contains the compiled Workspace Tasks entry, `taskDomain.js`, `docs/plugins.md`, and `docs/config.md`, while paired HTML pages remain repository-only. Verify no source/test/protected-file change occurred.

- [ ] **Step 3: Write the audit report and inspect scope**

Write exactly one report stating the exact final HEAD, source range, admitted evidence hashes, command outcomes, package contents, Changeset status, and absence of any recovery-7 temporary browser artifacts. Do not create a product commit. Return exactly one implementer status.
