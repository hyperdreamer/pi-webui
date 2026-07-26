# Changelog

## 1.8.0

### Patch Changes

- 5dc391f: Add a Compact control to the chat composer for manually summarizing session context.
- ff56a22: Allow pinned sessions to be unpinned directly from their star icon, with a button-like enlarged hover state and unpin hint.
- 0b8fe92: Group related sessions across project workspaces, with expandable parent rows and direct navigation to linked workspaces.
- 922e7d5: Dismiss session, project, and workspace action menus when clicking elsewhere in their lists.
- e7878a8: Refresh System Info memory and network rates independently while the Info tab is active, improve rate display, and avoid reloading unchanged machines.
- 67fbb2e: Place terminal modal appearance controls beside the Terminal title.
- 67fbb2e: Add maximize and restore controls to the terminal window.
- 67fbb2e: Make terminal shell close controls easier to target and accessible by keyboard.

## 1.7.0

### Patch Changes

- 7e79d3e: Display chat skill cards with a blue visual treatment.
- d530da5: Move System Info into the reorderable Activity Rail and keep Settings pinned at the bottom for consistent access.
- 16780cd: Clarify Browser as a lightweight embedded viewer and add a fail-closed remote-browser capability foundation. Arbitrary-site remote browsing remains unavailable until its isolated runtime security prerequisites are deployed.
- 98e139d: Add a destructive "Force Cleanup" button to the Clean up sessions dialog that permanently deletes all archived sessions regardless of age or cleanup settings, with a clear warning before execution.
- 3098d6a: Add **Edit from here** and **New session** actions to user messages, so you can revise a prior prompt in place or start an independent session from it.

## 1.6.0

### Patch Changes

- 7efd8aa: Show the current PI WEBUI version beside the sidebar application name.
- 9f8b9f2: Add an Activity Rail Browser with tabs, address navigation, reload, resizable window controls, and page zoom.
- 8bf61a4: Replace the Activity Rail File Manager with Git Update Manager for reviewing staged and unstaged workspace changes, highlighted diffs, and a changed-file count badge.
- cfc0279: Allow users to rearrange Activity Rail icons via drag-and-drop. The customized order persists across page reloads and the system info icon is always pinned at the bottom.

## 1.5.1

### Patch Changes

- Add a theme icon to the activity rail.
- Switch theme button from dark/light toggle to a palette icon.

## 1.5.0

### Patch Changes

- 8851af0: Add a workspace system-info panel with application versions, environment, hardware, network addresses, and live upload/download transfer rates.
- d16cde5: Keep minimap previews above session history and show every message preview while hovering the conversation navigator.

## 1.4.1

### Patch Changes

- 68e4c89: Refresh the sidebar wordmark with a prominent π symbol and WebUI capitalization.
- d02208f: Show the latest reachable Git tag in the workspace Git summary.

## 1.4.0

### Patch Changes

- d47359b: Add a Full history sidebar control that opens Pi session exports inside the app.

## 1.3.0

### Patch Changes

- d978088: Add a sidebar control for viewing the current session's resolved system prompt.

  Update the static-file server dependency to remediate URL-path authorization-bypass vulnerabilities.

## 1.2.0

- Add a desktop activity rail terminal launcher with an active-shell badge and a large translucent terminal modal that remembers font-size and opacity preferences.
- Make the sidebar terminal window movable and resizable with mouse drag controls.

## 1.1.0

- Add hover summaries and a detailed session-information popover to the chat usage badge.
