# Workspace Tasks Final Review Recovery 8 Design

**Date:** 2026-08-18

## Purpose

Complete the missing Frontier final review for the committed Workspace Tasks feature after correcting the source-range identity in the previous final-review handoff.

## Evidence boundary

The product source baseline is `b78bb44f0cb68ff4cfcc8b930af787263d665144`. The current recovery branch HEAD is `792f044f22f70792c9826f473f4af17786e9dc33`, whose only changes after the product baseline are the recovery-7 specification and plan. The final review range is therefore `5eda56bbab1c295e04623ed156039c3ddc847072..792f044f22f70792c9826f473f4af17786e9dc33`.

The recovery-6 Task 1 report and task-review approval are admitted verification evidence. The recovery-6 final-review child, recovery-7 audit child, and all mismatched prompts/reports are inadmissible. All predecessor run roots remain preserved and are not edited.

## Continuation

A single no-source-change task verifies the product baseline versus the documentation-only recovery range, independently checks the admitted recovery-6 task and review artifacts, runs build/package/Changeset checks, and creates a fresh final-review package and empty ledger. A fresh task reviewer then validates that handoff, followed by a correctly rendered Frontier final reviewer whose paths all point to recovery-8.
