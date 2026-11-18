# Selected-Session Notifications in the Activity Rail

**Status:** Draft for user review. The user selected layout A and approved the interaction and reliability sections; this document has not yet passed independent design review or received execution authorization.

## Goal

Move the current session's notification inbox from the strip above the chat to a predictable home in the Activity Rail. A bell above Settings opens a compact, non-modal tray so a user can inspect or dismiss notifications without losing the conversation. The inbox, bell count, and session title always refer to the selected session.

This is a relocation of the existing session inbox, not a global notification center or a new permanent history. Keep the session daemon as the owner of notification data and preserve the existing session and machine boundaries.

## Chosen Presentation

The user chose **A: Sidebar flyout** in the comparison below. B, the larger modal dialog, is not the chosen design.

![Comparison showing the selected sidebar flyout and the rejected activity dialog](assets/sidebar-notifications-comparison.png)

On desktop, place the bell directly above the fixed Settings control, independent of the reorderable core buttons and plugin activities. Clicking it opens a readable, scrollable flyout beside the rail. The flyout may cover part of the navigation panel, as shown in A; it does not resize the application, dim the background, trap focus, or block the rest of the chat.

On compact layouts, the bell remains in the compact Activity Rail. Selecting it closes the compact rail and opens the same inbox as a viewport-filling sheet. The sheet contains the same title, state, notifications, and actions as the desktop flyout. The compact rail launcher reflects the selected session's count while the rail is closed, so notifications remain discoverable without opening the rail. Existing rail ordering and plugin preferences are not changed.

## Inbox and Badge

- Display the selected session's name, using the existing session-title fallback when it has no name, and the full notification count in the tray.
- The badge represents the existing total of undismissed retained notifications plus the count of older notifications no longer shown. It is not an independent unread count. Hide a zero badge; display counts above 99 as `99+`, while exposing the full count in the accessible label and tray.
- Each visible notification retains its severity, time, message, truncation notice when applicable, and individually labelled dismiss control. Retain the existing indication when older notifications have been discarded by the bounded inbox.
- Provide a Clear all action scoped to the selected session. Opening, closing, or viewing the tray never dismisses notifications.
- The bell stays visible but disabled when there is no active selected session, including a pending or archived session. A current empty inbox shows an explicit empty state.
- A selected session's loading, unavailable, and empty states are distinct. Do not show a previous session's rows or badge as the current session's data. A stale or unavailable count is not presented as zero or as a current count.

## Interaction and Focus

- The desktop bell toggles the flyout. Escape, its close control, or a click outside the flyout closes it. The user can continue interacting with the chat; new notifications never open the flyout or move focus.
- A keyboard opening places focus in the tray. A close using Escape, the close control, or the bell restores focus to the bell when it is available. An outside click closes the tray without stealing focus from the clicked target.
- Clicking another session outside the flyout closes it as an outside click. If selection changes while the tray remains open, such as through a keyboard or route change, keep the surface open and immediately replace the old session's rows and count with the new session's loading or appropriate unavailable state. Never publish a late result for the previous machine, workspace, or session into the current tray.
- If the last notification is dismissed while focus is inside the tray, move focus to the tray heading or another stable action rather than dropping it onto the document. Disabling the bell or removing the tray during a session transition must not strand focus.
- The compact sheet closes through its close control or Escape and restores focus to the compact Activity Rail launcher when available. Its content fits and scrolls within the viewport, including narrow screens and mobile safe areas.

## Failure, Concurrency, and Lifetime

The existing selected-session notification controller owns inbox snapshots, events, optimistic dismissals, and selection generation checks. The UI consumes that one projection for the list and badge; it does not introduce a second independent notification store.

- While the selected inbox loads, show a loading state. When loading fails or the selected machine disconnects, show an unavailable state and a retry action rather than an empty inbox. Disable dismissal until a current inbox is available. Reconnection and an explicit retry refresh the currently selected session; a retry while the machine remains offline continues to report that it is unavailable.
- If an individual dismissal or Clear all fails, restore the affected visible notifications and report the failure. Existing per-notification pending state prevents duplicate actions. Clear all uses the captured session and dismissal watermark, so notifications arriving after the action began remain visible.
- Switching sessions never itself dismisses notifications. Notifications are held for the active session runtime and are not permanent history. Stopping or archiving a session, replacing its runtime, or restarting the session daemon may clear them under existing lifecycle rules. This feature does not change those rules or add persistence.
- Preserve compatibility with older or incapable remote runtimes. They must not be presented as a freshly loaded empty inbox; retain the existing legacy command-output behavior without duplicating notifications on capable runtimes.

## Existing Surfaces and Accessibility

Remove the selected-session notification list from the top-of-chat notices, including its old collapse control. Keep unrelated session warnings, speech errors, and action-blocking errors in their existing context surfaces. There is exactly one visible session-notification list at a time.

The bell has a meaningful accessible name that includes the selected-session notification count when current, reports whether the tray is open, and references the tray. The non-modal desktop tray has a labelled region; the compact sheet provides appropriate dialog and focus semantics. Notification dismiss and clear controls have accessible labels. Keep the existing polite and assertive screen-reader announcements for new notifications mounted independently of whether the tray is open, without duplicate announcements or focus theft.

Use the application's existing theme tokens, icon-button styling, selected-session identity, and responsive Activity Rail conventions. The mockup establishes structure and behavior, not fixed color values.

## Ownership and Scope

`PiWebUiApp` owns the open/closed state and the association between the selected session and the notification presentation. `ActivityRail` remains a presentation component that receives the bell state and callbacks. A focused notification-tray view renders the existing inbox projection and dispatches the existing dismiss and retry operations; it does not own transport or persistence. Keep session and machine identity checks in the existing controller boundary.

Do not introduce a plugin dependency for this core control, a global cross-session inbox, notification read/unread synchronization, new storage, or a session-daemon protocol change. Keep legacy command output and unrelated top-of-chat notices intact. User-facing documentation belongs on an appropriate detailed page under `docs/`, with a Changeset for the user-visible feature; the README remains a concise entry point.

## Verification

Use the repository testing guide and test observable behavior at the smallest meaningful layer.

- Controller and state tests cover current versus stale snapshots, selection and machine changes, late completions, dismiss failure recovery, Clear all racing a new notification, overflow, and unavailable or retry states.
- Component tests exercise the bell, count, tray and empty states, individual dismiss and Clear all, accessible names, announcements while closed, keyboard closing, focus return, and removal of the old notification strip without removing other notices.
- Real browser checks cover desktop flyout placement and outside-click behavior, compact sheet sizing and focus restoration, scrolling of long notifications, and the absence of overlap or clipped controls at desktop and mobile sizes.
- Preserve rolling compatibility with older runtimes and confirm that selecting another session does not mutate the previous session's inbox.
- Before final audit, run the full project suite and typecheck as required by the project workflow. No production tests or implementation have run during this design stage.
