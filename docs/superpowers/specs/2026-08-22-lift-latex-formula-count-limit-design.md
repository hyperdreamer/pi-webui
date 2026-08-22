# Lift LaTeX Formula Count Limit Design

## Problem

A settled message may currently render only eight formulas. The limit is caused by both `MAX_FORMULA_COUNT = 8` and eight fixed 32,000-character output reservations within the 256,000-character message output budget. A normal multi-step mathematical explanation therefore displays valid formulas after the eighth as literal source.

## Decision

Remove the formula-count admission limit and its fixed per-formula output reservation. Keep all existing per-formula source, structural, KaTeX expansion, sanitization, and aggregate TeX-source safeguards.

After KaTeX produces a fragment, account for its actual HTML length. Accept it only when the fragment is at most 32,000 characters and the accumulated accepted math output remains at most 256,000 characters. When either output limit is exceeded, preserve the current formula as exact literal source and close later math admission for that message.

This permits any number of small formulas whose total source and rendered output remain bounded. It does not make synchronous KaTeX work unbounded: each candidate remains limited to 512 source units and the message has a 4,096-unit aggregate source cap, structural limits, and a 256,000-character accepted output cap.

## Scope

Modify only the client LaTeX admission logic and its focused formatter tests. Add a patch Changeset because users will observe long math explanations rendering fully. Do not change the composer, Markdown scope rules, KaTeX options, cache behavior, host speech behavior, or server/session code.

## Regression Coverage

Add a focused test with more than eight small formulas and assert that every formula reaches the injected renderer. Retain tests proving the 4,096-unit aggregate source limit and post-render output overflow still preserve exact source and close later admission.

## Verification

Run the focused formatter and Markdown tests first, followed by typecheck, lint, Knip, the full serial verification suite, build, package validation, and a clean-diff check.
