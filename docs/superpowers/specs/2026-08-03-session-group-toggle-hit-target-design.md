# Session group toggle hit target

**Date:** 2026-08-03
**Status:** Approved design

## Problem

Parent sessions expose an expand/collapse disclosure button in both the navigation sidebar and the expanded Sessions browser. Each button is only `18px` square, so the arrow is difficult to acquire with a pointer.

The pinned-session star established the desired interaction treatment: it is a semantic button with a visible hover surface, border, scale feedback, focus styling, and an accessible label. The disclosure controls are already semantic buttons with accessible labels, but their small fixed hit area and quieter hover treatment make them harder to click.

## Decision

Increase the real disclosure-button hit target from `18px` to `24px` in both `SessionList` and `SessionBrowserDialog`. Keep the arrow glyph compact and preserve stable button dimensions so hover, focus, and folded-state changes cannot shift the row layout.

Use the pinned-star interaction as the visual reference:

- show a clear surface and one-pixel border-equivalent on hover;
- use `transform: scale(1.25)` as additional feedback, without relying on scaling as the hit-target fix;
- retain the existing visible focus outline;
- preserve the existing title, `aria-label`, `aria-expanded`, click propagation guard, and folding behavior.

Apply the same treatment in both session views. They expose the same session-family operation, so changing only one would create an avoidable inconsistency.

## Alternatives

### Copy only the pinned-star hover scale

This is the smallest CSS change, but scaling starts only after the pointer reaches the original target. It improves feedback without fully addressing initial pointer acquisition.

### Change only the sidebar

This addresses the denser view where the problem may be most noticeable, but leaves an identical control in the expanded browser with different interaction behavior.

### Add an oversized pseudo-element hit area

This can preserve the `18px` layout box, but an invisible overlapping target can intercept clicks intended for the adjacent session label. A visible, stable `24px` button is easier to understand and test.

## Implementation Boundary

This is a local presentation change in:

- `src/client/src/components/SessionList.ts`;
- `src/client/src/components/SessionBrowserDialog.ts`.

No controller, session-tree projection, API, persistence, server, session daemon, or configuration behavior changes. Keep the duplicated component-local styles aligned rather than introducing a new shared style abstraction for two declarations.

## Verification

Follow TDD with focused component tests that first fail against the current `18px` controls. Assert that both components provide:

- a stable `24px` width, minimum width, and height;
- the visible hover surface and border-equivalent;
- the `1.25` hover scale feedback.

Existing interaction tests continue to cover disclosure labels, expanded state, click propagation, and folding. Run both focused Vitest files, typecheck, lint the changed files, and finish with `npm run verify` because the CSS affects two user-facing views.

## Acceptance Criteria

1. The sidebar and expanded Sessions browser disclosure buttons both have a real `24px` square hit target.
2. Hovering either control shows the same clear button affordance used by the pinned-session star and scales it to `1.25`.
3. Arrow size and surrounding row layout remain stable between collapsed, expanded, hover, and focus states.
4. Existing disclosure accessibility and folding behavior remain unchanged.
5. Focused tests and `npm run verify` pass.
6. Add a patch Changeset for the user-visible UI improvement; do not edit `CHANGELOG.md` directly.
