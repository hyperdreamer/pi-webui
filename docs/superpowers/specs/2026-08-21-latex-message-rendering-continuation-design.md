# LaTeX Message Rendering Continuation Design

**Date:** 2026-08-21

## Purpose

The original deterministic SDD run for LaTeX message rendering reached `DISPATCH_MISMATCH_BLOCKED` after the Task 3 reviewer received a prompt that differed from its persisted rendered prompt by one leading whitespace byte. The reviewer result is sealed and is not evidence for completion. The feature implementation itself is a valid committed range ending at `9bf12e593d6963124450df7d1a83b59189fb2f04`.

This continuation preserves the blocked run root and starts a distinct deterministic run. Its first task performs a no-source-change audit and fresh independent review of the exact Task 3 range. Its second task performs the remaining production, packaging, browser, accessibility, nested-deployment, and performance verification.

## Pinned Source Range

The Task 3 deliverable is exactly:

- Base: `60c87d8760ce7cf64fdf384b933b6c09744ab5d8`
- Head: `9bf12e593d6963124450df7d1a83b59189fb2f04`
- Changed files: `src/client/src/components/FormattedText.ts`, `src/client/src/components/FormattedText.test.ts`, and `src/client/src/components/ChatView.latex.test.ts`

The continuation must not recreate, amend, or rebase this range. The continuation plan and specification are documentation commits made after the pinned head; they are not part of the Task 3 audit range.

## Evidence Rules

The blocked run at `/data/home/guest/Development/pi-webui/.worktrees/latex-message-rendering/.superpowers/sdd/2026-08-21-latex-message-rendering` remains byte-preserved. Its state, progress ledger, prompts, reports, packages, and mismatch event are retained for provenance only. No report, verdict, or finding from that run may be used as evidence in the continuation.

Git commits, independently inspected source, newly run tests, newly generated packages, production build output, and raw Chromium/CDP measurements are the evidence sources. Every continuation dispatch must persist the exact rendered prompt before spawning, record the returned child session immediately, and compare the child's initial user message byte-for-byte with the stored prompt before admitting its report.

## Review Boundary

Task 1 is read-only and may not modify source, tests, package metadata, plan files, or the index. It must independently inspect the pinned Task 3 range, verify the Task 3 requirements, and run the relevant tests and static checks. The controller's task-review gate is a separate fresh review of the same exact range, not an acceptance of the audit child or the sealed blocked-run reviewer.

Task 2 owns production verification. It may modify source only if a real browser probe measures a shipped defect. Such a repair requires a focused RED test, the smallest GREEN fix, a new commit, and repetition of the failed probe. Verification-only fixtures and outputs must be removed.

## Completion

After both continuation tasks receive independent approval, a fresh Frontier final review covers the complete branch from the feature base. Completion requires the original composer, server, session-daemon, Markdown, sanitization, cache, speech-isolation, KaTeX option, resource-budget, packaging, accessibility, nested-deployment, and cleanup contracts to remain satisfied, with no open load-bearing findings and a clean worktree.
