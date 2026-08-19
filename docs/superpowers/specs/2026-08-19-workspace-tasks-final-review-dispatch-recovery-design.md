# Workspace Tasks Final Review Dispatch Recovery Design

**Date:** 2026-08-19

## Purpose

Recover from a blocked F-3 task review whose exact bootstrap referenced a missing run-local dispatch file and whose `dispatch-started` correlation was not recorded before the child ran.

## Goal

Obtain a fresh admissible F-3 review, independently review it, and complete final Frontier review over the original merge-base-to-HEAD range.

## Evidence Boundary

Preserve all prior runs, reports, findings, prompts, receipts, and states. The current F-3 audit report is admissible source-audit evidence. The blocked review report remains admissible process evidence but cannot approve the task. The source candidate is `bb96c94131b7283076ba479427186f782629a252`; all correctness claims must be verified from source and fresh commands.

## Dispatch Control

Persist the complete dispatch instruction file first, verify it exists and contains all referenced paths, persist the one-line bootstrap second, then create the dispatch intent. Spawn only after those checks. Record the returned session ID in `dispatch-started` immediately. Compare the first user message byte-for-byte before admitting any report.
