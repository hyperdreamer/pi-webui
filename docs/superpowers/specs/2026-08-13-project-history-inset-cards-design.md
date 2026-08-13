# Project History inset cards - design

## Goal

Polish the populated Project History list in the Recent Projects workspace tab. Each history entry should read as one continuous card with balanced space on both sides, and its remove action should appear inside that card instead of occupying a permanently visible trailing column.

This design changes only Project History entries rendered by `RecentProjectsPanel`. It does not change the left navigation, Activity Rail, workspace-panel divider, workspace tab header, Files, Git, terminals, project registration, or history persistence.

## Approved appearance

- Every populated Project History entry is inset `8px` from the left and right edges of the panel content area.
- The workspace-panel divider, Recent Projects clock-tab header, and list scrollbar remain at their current positions.
- Each entry has one continuous border, background, and rounded outline across its full width.
- The remove `X` sits inside the entry's top-right trailing area. There is no detached button segment, permanent divider, or empty-looking reserved column.
- The entry text keeps enough internal trailing padding to avoid rendering beneath the remove control when it appears.
- Existing project activity indicators remain visible in a stable position immediately left of the remove hit area. They do not overlap the remove control or move when hover reveals it.
- Existing typography, row height, vertical spacing, selection styling, status text, and path wrapping remain unchanged.
- Loading, failure, and empty Project History states remain unchanged because there is no entry card to inset.

The approved visual baseline is the side-by-side resting and hovered rendering reviewed in this conversation. The resting state shows uninterrupted cards with no visible remove region. The hovered state shows the `X` inside the same card at its top-right. Both states keep equal `8px` outer gutters.

## Interaction behavior

On hover-capable devices, the remove control is completely invisible while its entry is at rest. It appears when either:

- the pointer hovers over that entry; or
- keyboard focus is within that entry.

When the pointer leaves and the entry does not contain focus, the control becomes invisible again. Revealing it does not alter the card's dimensions or move its text.

On devices without hover, the remove control remains visible inside the card so removal is discoverable and operable by touch. This is the existing accessibility exception to desktop hover-only presentation.

The remove control retains its current `32px`-wide hit area, tooltip, project-specific accessible name, keyboard stop, focus indication, and event isolation. Activating it must not open or select the history entry. The existing removal-confirmation and post-removal focus behavior do not change.

## Component design

Keep the existing valid interaction structure in `RecentProjectsPanel`: a non-interactive row container with sibling primary-action and remove buttons. Do not place the remove button inside the primary button, because nested interactive elements are invalid and would compromise pointer and keyboard behavior.

Use component-scoped layout styles to create visual containment:

- Add `8px` inline padding to `.recent-projects-list`, with border-box sizing so the list does not become wider than its panel.
- Make `.recent-project-row` a single visual positioning container instead of a two-column grid.
- Let `.recent-project-open` fill the row, restore rounding on all four corners, and reserve internal trailing text space for the remove hit area.
- Position `.recent-project-remove` absolutely at the row's right edge, fully within the primary card bounds.
- Keep activity indicators in a stable trailing position immediately to the left of the remove hit area, with sufficient content padding for both regions.
- Remove the close control's own separating border and use the underlying entry background so resting, hover, and selected states remain visually continuous.
- Preserve `:hover`, `:focus-within`, `:focus-visible`, and `@media (hover: none)` behavior.

This is a local presentation change. It introduces no new state, callback, controller, API, persistence behavior, or reusable abstraction.

## Considered approaches

### Visual overlay with sibling controls

This is the approved approach. It produces one continuous card while preserving valid semantics, separate focus targets, and the existing event boundaries. It requires only local component styles.

### Put the remove button inside the primary button

Rejected. Although the DOM would resemble the visual request, a button inside another button is invalid interactive markup and creates ambiguous activation and focus behavior.

### Keep a two-column row and hide the trailing segment

Rejected. The trailing column still reserves a visibly separate region and recreates the empty-margin problem called out in review.

## Accessibility and responsive behavior

- The primary action and remove control remain separate keyboard stops.
- Tabbing to the visually hidden remove control reveals it through `:focus-within` before activation.
- Focus outlines remain visible and must not be clipped by the list gutters.
- Hover-capable devices hide the control at rest; non-hover devices show it continuously.
- Long names and paths cannot overlap either the activity indicator or close control.
- Activity indicators remain visible and stationary in resting, hover, and focus states.
- The `8px` left and right card gutters apply at desktop and narrow panel widths without introducing horizontal overflow.

## Testing and verification

Follow test-driven development. Add focused component coverage before changing production styles.

Component tests should establish that:

- Project History list styles provide `8px` left and right insets without changing generic shared-list layouts.
- The row no longer uses a permanent trailing visual column.
- The primary action fills and rounds the full card.
- The remove control is positioned inside the entry bounds with no separating border.
- Hover and `:focus-within` reveal the control on hover-capable devices.
- The non-hover media rule keeps it visible for touch input.
- Existing accessible labels, activation isolation, selection, and focus-restoration behavior continue to pass.

Use a real Chromium layout probe against the live UI to verify:

- card left edge minus panel content left edge is exactly `8px`;
- panel content right edge minus card right edge is exactly `8px`;
- the remove control's bounds are fully contained by the card;
- activity indicators remain visible to the left of the remove control and neither element moves or overlaps as visibility changes;
- the tab header and scrollbar positions do not move;
- resting, hover, keyboard-focus, and non-hover states render as specified;
- desktop and narrow viewports have no horizontal overflow or text/control overlap.

Run the focused `RecentProjectsPanel` tests, typecheck, lint for changed files, `npm run verify:fast`, and `git diff --check`. Run the serial `npm run verify` before final integration.

## Release and documentation

Add a patch Changeset for `@hyperdreamer/pi-webui` describing the balanced Project History card spacing and inline hover/focus remove action. Do not edit `CHANGELOG.md` manually.

No README, user configuration, or operational documentation changes are needed. This is self-explanatory UI polish with no configuration or runtime impact.

## Scope boundaries

- No changes to project history ordering, recording, loading, removal, confirmation, or persistence.
- No changes to project registration, workspaces, sessions, terminals, or files.
- No changes to workspace tabs other than the populated Recent Projects rendering.
- No new animations, configurable spacing, or alternate card treatments.
- No Activity Rail, navigation panel, workspace shell, session-daemon, protocol, or server changes.
