# Project History inset cards - design

## Goal

Polish the populated Project History list in the Recent Projects workspace tab. Each history entry should read as one continuous card with balanced space on both sides, and its remove action should appear inside that card instead of occupying a permanently visible trailing column.

This design changes only Project History entries rendered by `RecentProjectsPanel`. It does not change the left navigation, Activity Rail, workspace-panel divider, workspace tab header, Files, Git, terminals, project registration, or history persistence.

## Superseded contract

This design supersedes only the trailing-layout requirements in `2026-08-13-recent-project-history-removal-controls-design.md` that say the remove button occupies stable row space and that its reserved dimensions prevent layout shift. The remove control remains a stable `32px`-wide interaction target, but it is overlaid within the full-width card instead of receiving a separate grid column. Layout stability is preserved through permanent internal trailing padding in the primary action.

All other removal-control requirements remain authoritative, including sibling-button semantics, accessible naming, confirmation, event isolation, keyboard access, touch visibility, and focus restoration.

## Approved appearance

- Every populated Project History entry has an `8px` inline-start gutter from the panel content edge and an `8px` inline-end gutter from the list's usable content edge. With a non-overlay scrollbar, the inline-end gutter sits between the card and scrollbar track.
- The workspace-panel divider, Recent Projects clock-tab header, and list scrollbar remain at their current positions.
- Each entry has one continuous border, background, and rounded outline across its full width.
- The remove `X` sits inside a transparent, full-height `32px` trailing target within the entry. There is no detached button segment, permanent divider, empty-looking reserved column, or tinted trailing area.
- The primary action uses `54px` of internal trailing padding: the existing `22px` content allowance plus the overlaid `32px` remove target. This preserves the current trailing reservation relative to the card width, so the overlay itself causes no additional text shift or wrapping.
- Existing project activity indicators remain visible at `right: 38px`, immediately left of the remove target. This preserves their current 6px inset relative to the usable primary-action edge, prevents overlap, and keeps them stationary when the remove action appears.
- Existing typography, base vertical padding, selection styling, status text, and path-wrapping rules remain unchanged. The cards are intentionally `16px` narrower overall because of the two approved `8px` gutters, so a long path may naturally wrap one line earlier; row height remains content-driven.
- Loading, failure, and empty Project History states remain unchanged because there is no entry card to inset.

The approved visual baseline is the side-by-side resting and hovered rendering reviewed in this conversation. The resting state shows uninterrupted cards with no visible remove region. The hovered state shows the `X` inside the same card at its right edge. Both states keep equal `8px` outer gutters. The approved audit resolution uses the full-height target, corrected activity-indicator position, and icon-only direct-hover feedback.

## Interaction behavior

On hover-capable devices, the remove control is completely invisible while its entry is at rest. It appears when either:

- the pointer hovers over that entry; or
- keyboard focus is within that entry.

When the pointer leaves and the entry does not contain focus, the control becomes invisible again. Revealing it does not alter the card's dimensions, move its text, or move its activity indicator. Direct pointer hover over the remove control changes only the `X` icon from `var(--pi-muted)` to `var(--pi-text)`; the target itself remains transparent so no trailing segment reappears. A keyboard focus outline may still identify the target as required for accessibility.

On devices without hover, the remove control remains visible inside the card so removal is discoverable and operable by touch. This is the existing accessibility exception to desktop hover-only presentation.

The remove control retains its current `32px` width and spans the full entry height. It keeps its tooltip, project-specific accessible name, keyboard stop, focus indication, and event isolation. Activating it must not open or select the history entry. The existing removal-confirmation and post-removal focus behavior do not change.

## Component design

Keep the existing valid interaction structure in `RecentProjectsPanel`: a non-interactive row container with sibling primary-action and remove buttons. Do not place the remove button inside the primary button, because nested interactive elements are invalid and would compromise pointer and keyboard behavior.

Use component-scoped layout styles to create visual containment:

- Add `8px` inline padding to `.recent-projects-list`, with border-box sizing so the list does not become wider than its panel.
- Make `.recent-project-row` a single visual positioning container instead of a two-column grid.
- Let `.recent-project-open` fill the row, restore rounding on all four corners, and use `54px` of trailing padding. This preserves the current trailing reservation relative to the card width while protecting the overlaid action and indicator regions; the only content-width reduction comes from the approved outer gutters.
- Position `.recent-project-remove` absolutely at `top: 0` and `right: 0`, with `32px` width and `100%` height, fully within the primary card bounds.
- Keep the remove target transparent with `border: 0` in resting, row-hover, selected, and direct-hover states. Direct hover changes only the icon from `var(--pi-muted)` to `var(--pi-text)`; keyboard focus retains its visible outline.
- Override `.action-activity` locally to `right: 38px`, placing its `10px` box immediately left of the remove target with a 7px box-to-target gap. The rendered `7px` dot sits centered inside that box. The offset is constant across resting, hover, selected, and focus states.
- Preserve `:hover`, `:focus-within`, `:focus-visible`, and `@media (hover: none)` behavior.
- Use ordinary component-scoped selectors. The component's static styles follow `listStyles`, so this design requires no `!important` declarations.

This is a local presentation change. It introduces no new state, callback, controller, API, persistence behavior, or reusable abstraction.

## Considered approaches

### Visual overlay with sibling controls

This is the approved approach. It produces one continuous card while preserving valid semantics, separate focus targets, and the existing event boundaries. It requires only local component styles.

### Put the remove button inside the primary button

Rejected. Although the DOM would resemble the visual request, a button inside another button is invalid interactive markup and creates ambiguous activation and focus behavior.

### Use a centered 32 by 32 remove target

Rejected. It fits inside the card but unnecessarily reduces the pointer and touch target compared with the existing full-height control. The approved target remains `32px` wide and spans the row height while staying visually transparent.

### Tint the remove target on direct hover

Rejected. A tinted target makes a trailing segment visible again. The approved direct-hover feedback changes only the icon from `var(--pi-muted)` to `var(--pi-text)`.

### Keep a two-column row and hide the trailing segment

Rejected. The trailing column still reserves a visibly separate region and recreates the empty-margin problem called out in review.

## Accessibility and responsive behavior

- The primary action and remove control remain separate keyboard stops.
- Tabbing to the visually hidden remove control reveals it through `:focus-within` before activation.
- Focus outlines remain visible and must not be clipped by the list gutters.
- Hover-capable devices hide the control at rest; non-hover devices show it continuously.
- Long names and paths cannot overlap either the activity indicator or close control. The overlay introduces no extra content-width loss beyond the intentional `16px` reduction from the two outer gutters.
- Activity indicators remain visible at `right: 38px` and stationary in resting, hover, selected, and focus states.
- The `8px` left and right card gutters apply at desktop and narrow panel widths without introducing horizontal overflow.

## Testing and verification

Follow test-driven development. Add focused component coverage before changing production styles.

Component tests should establish that:

- The existing `"reserves a fixed action slot with hover, focus, and non-hover visibility rules"` test is replaced. Its assertion requiring `grid-template-columns: minmax(0, 1fr) 32px` is superseded by this design.
- Project History list styles provide `8px` left and right insets without changing generic shared-list layouts.
- The row no longer uses a permanent trailing grid column.
- The primary action fills and rounds the full card and uses `54px` trailing padding.
- The remove control is absolutely positioned at the entry's right edge with `32px` width, `100%` height, no separating border, and a transparent background in ordinary pointer states.
- `.action-activity` uses the component-local `right: 38px` offset.
- Hover and `:focus-within` reveal the control on hover-capable devices, while direct remove-control hover changes only the icon from `var(--pi-muted)` to `var(--pi-text)`.
- The non-hover media rule keeps it visible for touch input.
- Existing accessible labels, activation isolation, selection, and focus-restoration behavior continue to pass.

Use a real Chromium layout probe against the live UI to verify:

- card left edge minus panel content left edge is exactly `8px`;
- the card's inline-end gutter is exactly `8px` from the list's usable content edge; when a non-overlay scrollbar is present, this means `8px` between the card and scrollbar track rather than `8px` through the scrollbar to the panel edge;
- the remove control measures `32px` wide by the full card height and its bounds are fully contained by the card;
- the activity indicator's `10px` box lies entirely left of the remove target, with the measured 7px box-to-target gap, and neither element moves as visibility changes;
- direct hover over the remove action changes only the icon from `var(--pi-muted)` to `var(--pi-text)` and does not reveal a tinted or bordered trailing segment;
- the tab header and scrollbar positions do not move;
- resting, hover, keyboard-focus, and non-hover states render as specified;
- desktop and narrow viewports have no horizontal overflow or text/control overlap, and any additional path wrapping is attributable only to the intentional `16px` card-width reduction from the outer gutters.

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
