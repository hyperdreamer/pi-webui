# Workspace Tasks Verification Recovery 5 Design

**Date:** 2026-08-18

## Purpose

Complete one fresh, admissible verification pass for the committed Workspace Tasks feature after the recovery-3 and recovery-4 runs each contained an inadmissible dispatch path. This recovery makes no product redesign and accepts no predecessor browser report, fixture, runner, transcript, or result as evidence.

## Baseline and sealed predecessors

The baseline source commit is `731aa47afad200413ccbd7ef670ff9314d1780b4`. It contains only the committed Workspace Tasks feature range plus recovery planning documents. The authoritative feature-range base remains `5eda56bbab1c295e04623ed156039c3ddc847072`. The source/test projection from `04120a41712f7f5bb8a94da8b7f23c58e8bc3dfb` to the baseline is empty; later changes are recovery planning documents only.

The recovery-3 and recovery-4 run roots are preserved as audit records. Their Task 2 reports and browser artifacts are inadmissible. No file below their run roots or `/tmp/workspace-tasks-cdp-recovery-3` or `/tmp/workspace-tasks-cdp-recovery-4` is read as evidence or reused.

## One-task verification strategy

A single fresh task avoids splitting browser acceptance and serial verification across two implementer dispatches. It creates a new fixture, smoke runner, and acceptance runner under `/tmp/workspace-tasks-cdp-recovery-5`. The fixture imports the current generated Workspace Tasks panel only through a strict local-module allowlist. Raw CDP connects only to a newly discovered page target from its own Chromium process.

The browser matrix covers desktop and narrow viewports with Classic, PI WEBUI Dark, and PI WEBUI Light. It checks theme identity and canonical token values, geometry and overflow, filters, disclosures, scoped IDs, promotion/demotion/collision, recovery states, Retry gating, keyboard/focus paths, and terminal metadata. Startup failure handling is also probed for profile and process cleanup. Fixture failures remain temporary; a shipped panel fix requires a fresh measured defect, deterministic RED, minimal source/test fix, focused GREEN, repeated browser measurement, and a commit.

After browser acceptance, the same task runs the prescribed focused suites, serial server suite, `verify:fast`, `verify`, build, dry-pack, changelog status, and diff check serially. It removes the recovery-5 temporary root and reports exact command outcomes, package contents, final head, and clean scope. A normal task review and the mandatory whole-branch Frontier final review remain required.
