# E-Ink Minimap Handle Design

**Date:** 2026-08-11

## Goal

Use the xterm palette color 225 (`#FFD7FF`) for the conversation minimap viewport handle only when the active theme is E-Ink Color Paper.

## Design

Keep the existing `.viewport-indicator` declarations based on `--pi-text` for all themes. Add a `:host-context` override in `ChatMinimap` for the qualified theme attribute `data-pi-web-ui-theme="themes:eink-color-paper"`; the override uses `#FFD7FF` in the existing background and border color mixes.

This keeps the change local to the minimap, does not alter text or other theme tokens, and avoids expanding the public theme-token API for a single theme-specific visual adjustment.

## Verification

Run the focused client tests or type/build checks that cover the changed client component, then run `git diff --check`. Confirm the diff contains the theme-scoped CSS override and a patch Changeset entry, with no changes to other minimap markers or tooltip colors.
