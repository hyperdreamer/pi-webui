# Workspace Tasks Final Review Recovery 9 Design

**Date:** 2026-08-18

## Purpose

Complete the missing Frontier final review for the committed Workspace Tasks feature without treating continuation-document commits as product source changes.

## Identity model

The immutable product source baseline is `b78bb44f0cb68ff4cfcc8b930af787263d665144`; the whole feature-range base is `5eda56bbab1c295e04623ed156039c3ddc847072`. The continuation branch may contain additional committed recovery spec/plan files. The audit records its observed HEAD and proves that the source/test projection from the product baseline to that HEAD is empty. The final reviewer uses the observed HEAD, not a hard-coded parent commit.

## Evidence boundary

The recovery-6 Task 1 implementer and task-review reports are admitted evidence. The recovery-6 final-review child, recovery-7 audit child, and recovery-8 blocked child outputs are inadmissible. All predecessor run roots remain preserved and are not edited.

## Continuation

One no-source-change task verifies identity and admitted evidence, runs build/package/Changeset checks, creates a fresh final-review package and empty ledger, and reports its observed HEAD. Fresh task review and Frontier final review consume only recovery-9 artifacts.
