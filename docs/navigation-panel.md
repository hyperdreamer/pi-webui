# Navigation panel

The navigation column can be resized down to 324px. Its default width remains 340px. An older saved width below 324px is clamped when it is loaded; no preference migration is needed.

## Header labels

The π symbol, WebUI wordmark, and Actions control remain available as the column narrows. The visual version label hides when the navigation panel itself is narrower than 372px and returns from 372px. The brand's accessible name continues to include the version.

On desktop layouts at least 1181px wide, the 44px Activity Rail is reserved inside the navigation column. This means the version label hides at a 415px column and appears at 416px. In the 761–1180px drawer layout, the inner panel uses the full column width, so the version boundary is 372px of column width.

When more than one machine is available, the header shows the machine switcher. Long names use an ellipsis; the full name remains in the accessible label and tooltip. Remote-machine tooltips also include the address. With zero or one machine, the header omits the switcher.

The selected machine's health word becomes a coloured dot when the switcher itself is narrower than 150px. The word returns from 150px. Hovering the health indicator still shows the status text, and assistive technology receives a description such as “Machine status: online.” Menu entries continue to show full health words. Activity indicators retain their existing behaviour and are suppressed for offline or error states.

## Reloading an installed app

The navigation header has no reload control. In installed-app/PWA display mode, use the control named **Full page reload** in these locations:

| Window width | Reload location |
| --- | --- |
| 1181px and wider | Activity Rail fixed controls, immediately above the notification bell |
| 761–1180px | Context bar; also in the Activity Rail drawer when it is open |
| 760px and narrower | Context bar |

At 1181px and wider, the fixed controls appear in this order when reload is visible: **Full page reload**, notification bell, then **Settings**. Reload and the notification bell remain outside rail reordering. These reload controls are not shown in an ordinary browser tab.

## Selected-session notifications

The Activity Rail has a fixed notification bell immediately above **Settings**. The bell stays outside the reorderable core controls and plugin ordering. On compact layouts, the bell remains in the compact Activity Rail, and its launcher remains available while the rail is closed.

The bell and compact launcher always refer to the selected session. A fresh inbox shows the selected session's title, using the existing title fallback when the session has no name, and its full notification count. The badge hides a zero count and displays counts above 99 as `99+`. The full count includes retained notifications and older notifications that the bounded inbox has discarded.

On desktop, activating the bell opens a scrollable flyout beside the Activity Rail. The flyout does not resize or dim the chat. On compact layouts, activating the bell closes the rail and opens the same inbox in a viewport-filling modal sheet. The sheet provides the selected-session title, notification rows, overflow indication, and dismissal actions in one visible list. Opening, closing, viewing, or changing layout does not dismiss notifications. Escape and the close control close the open surface. Clicking outside the desktop flyout closes it while leaving the clicked destination usable.

The selected session determines the state shown by the bell and surface:

| Selected-session state | What appears | Recovery |
| --- | --- | --- |
| No eligible session, including a pending or archived session | Disabled bell with no count or rows | Select an eligible session |
| Machine is explicitly offline | Enabled bell with an offline explanation; no count, rows, or dismissal controls | **Retry** checks the machine again and waits for it to become reachable before reading the inbox |
| Notification capability is unknown or capability negotiation failed | Capability-unavailable explanation with **Retry**; no count, rows, or dismissal controls | **Retry** runs capability recovery, then reads the inbox only when support is established |
| Runtime does not support the notification inbox | Unsupported-runtime explanation with no inbox retry | Existing legacy command output remains available |
| Supported and reachable with a fresh inbox | Current rows and full count, or an explicit empty state | Use the row controls or **Clear all** for intentional dismissal |
| A current inbox read is pending without a fresh view | Loading state with no old rows or count | Wait for the current read to finish |
| Data is stale, missing, or a refresh failed | Unavailable explanation with **Retry** and no current count or rows | **Retry** refreshes the selected session |

Each visible row keeps its severity, received time, message, truncation notice when applicable, and labelled dismiss control. **Clear all** applies to the selected session. Dismissals are optimistic. If an action fails, the affected notifications return and the surface reports the failure. Notifications that arrive after **Clear all** begins remain visible. Only an explicit dismissal action changes the inbox.

The session daemon owns the notification inbox in memory. Switching sessions does not dismiss either session's notifications. Stopping or archiving a session, replacing its runtime, or restarting the session daemon may clear notifications under the existing lifecycle rules. The Activity Rail does not add a permanent notification history. The notification list moves out of the notices above chat, while unrelated session warnings, speech errors, action-blocking errors, and legacy command output remain in their existing contexts.

## Developer verification

Run `npm run verify` for the standard checks. Run `npm run verify:narrow-navigation-header` separately for actual header geometry, container-query boundaries, native keyboard activation, and reload placement. The latter requires a discoverable Chromium executable or `CHROME_BIN=/path/to/chrome` and fails if Chromium is unavailable.

The browser harness accepts `--source-overlay <directory>` for a regression negative control. The directory must contain `src/client/src/components/MachineSwitcher.ts` and `src/client/src/components/appShell/AppNavigationPanel.ts` extracted unchanged from `v1.26.0`. That run must fail on kicker fit, overlap, or name readability; an import or missing-selector failure is not valid evidence.
