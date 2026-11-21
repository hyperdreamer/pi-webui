# Browser desktop alerts for idle sessions

## Background

PI WEBUI already has a session-scoped notification inbox. Extensions can place informational, warning, and error messages in that inbox, and users can dismiss them from the chat view. Those messages may contain extension-provided text.

This feature adds browser-level desktop alerts for a different event. A selectable session completes active work and becomes idle while the user is looking elsewhere. The existing daemon-owned unread catalog already records these active-to-idle completions and sends `sessions.unread` events to the browser.

The new feature must remain distinct from the session notification inbox in terminology, settings, event handling, and content. Browser alerts contain only a session name, a project name, and idle wording. They never carry prompt text, assistant response text, extension notification text, or inbox severity.

## Goals

- Add an opt-in browser preference for desktop alerts in a dedicated Notifications settings section.
- Request browser permission only as a result of enabling the preference.
- Alert once for an eligible live active-to-idle completion when the user is looking elsewhere.
- Cover sessions on connected machines and across projects using the existing unread event subscriptions.
- Deduplicate across tabs in the same browser profile and origin, including concurrent event handling.
- Focus PI WEBUI and navigate to the corresponding machine, project, workspace, and session when an alert is clicked.
- Explain denied permission, unavailable browser support, and live-delivery limits in Settings.
- Keep session inbox messages and their existing event path unchanged.

## Non-goals

- Push notifications while every PI WEBUI page is closed or disconnected.
- Alerts for tracked child sessions excluded from the daemon unread catalog.
- Alerts reconstructed from unread snapshots, page load, reconnect, or an already-idle session.
- Prompt, response, tool output, or extension message content in browser alerts.

## Decisions

- **Tracked child sessions** follow the daemon unread catalog and remain excluded.
- **Settings location** is a new standalone Notifications section, scoped to this browser profile and origin.
- **Settings layout** uses mockup A, with the enable switch, permission state, test action, alert conditions, and delivery limits together in a direct-control panel.
- **Feature name** is “Browser notifications” in the new settings section. The copy explicitly says that these alerts are separate from the session notification inbox shown in chat.
- **Alert wording** uses “Session is idle”. Idle does not imply success. The title and body include resolved session and project names with safe fallbacks.
- **Delivery source** is the existing daemon unread completion catalog and its live `sessions.unread` event. The browser feature consumes completion identity and catalog metadata only. It does not consume `notifications.inbox` or `notifications.summary` content.
- **Eligibility** requires a socket-received, non-null unread completion whose catalog ID matches the machine's snapshot-established alert epoch and whose claim identity is unclaimed. A live window that is focused, visible, and actually showing that exact session suppresses the alert. A hidden or unfocused window, a window showing another session, or a focused window whose chat is covered by a tool, settings, or modal may alert.
- **Cross-tab coordination** is split into two independent decisions. Duplicate display is prevented by an origin-shared IndexedDB claim written before the browser notification is constructed. Simultaneous display while another window is watching the finished session is prevented by a BroadcastChannel viewer query that live tabs answer from their current chat-visibility state. Neither decision depends on a stored record of another tab's focus. If IndexedDB is unavailable, delivery fails closed and Settings explains it. If BroadcastChannel is unavailable, duplicate display is still prevented but cross-tab viewer suppression is not, and Settings states that limitation.

## Separation from the session notification inbox

| Concern | Session notification inbox | Browser desktop alerts |
| --- | --- | --- |
| Purpose | Extension and PI WEBUI messages shown in chat | Active-to-idle session completion while the user is looking elsewhere |
| User-facing name | Session notifications | Browser notifications |
| Settings | Existing chat inbox controls | New standalone Notifications settings section |
| Event path | Existing `notifications.inbox` and `notifications.summary` events | `sessions.unread` completion identity consumed by a browser-alert controller |
| Content | Message text and severity | Session name, project name, and “Session is idle” wording |
| Lifecycle | Session notification inbox lifecycle and dismissal | Browser permission, local opt-in, completion identity, and cross-tab claim |

The browser-alert controller must not import or call `SessionNotificationController`, inbox dismissal code, or extension notification message formatting. Shared UI wording must identify the desktop alert surface as browser-level.

## User experience

The Notifications settings section contains one “Browser notifications” panel. It shows an “Enable browser notifications” switch, browser permission state, an explicit test-notification button, conditions for receiving alerts, and a delivery-limits note. The panel states that browser alerts are separate from the session notification inbox shown in chat.

The browser permission prompt is initiated only by the enabling action. If permission is denied, the panel explains that the browser blocks alerts and offers the operating-system/browser settings guidance available to the page. Turning the feature off never requires permission and stops future alerts immediately.

Unsupported Notification API, insecure context, unavailable permission, unavailable IndexedDB coordination, and notification construction/display failures are shown as browser-alert availability states. They do not affect session event processing or session operation.

Alerts contain no user prompt, assistant response, or extension-supplied message. A click closes the alert, focuses the PI WEBUI window, and requests navigation to the alert's machine/project/workspace/session route. If the machine, project, workspace, or session has disappeared, PI WEBUI shows an explicit unavailable-target notice.

## Completion detection and lifecycle

A candidate is created when a `sessions.unread` message is received from a machine's unread socket, before the message is applied to any projection. Admission depends on the machine's capability being `unknown` or `supported`; a machine that has resolved to `unsupported` discards every incoming completion immediately, because it has no unread catalog to validate against. Admitting `unknown` is what keeps a live completion that arrives during capability renegotiation. The candidate carries the machine identity, catalog ID, catalog revision, session ID, workspace path, completion order, and unread summary or `null`.

### Alert epoch

Each machine has one alert epoch: the catalog ID of the most recently accepted HTTP catalog snapshot. Only a snapshot installs or replaces an alert epoch. Socket messages never install, replace, or regress it, and projection state never defines it.

That rule needs an explicit seam, because the unread controller's existing change notification does not distinguish a snapshot from a socket-applied projection. `SessionUnreadController` therefore gains `onSnapshotAccepted(listener)`, invoked only after `applyNetworkSnapshot` accepts a snapshot, with `{ machineId, catalogId, catalogRevision }`. The alert controller installs epochs exclusively through that callback; `applyEvent`, including its catalog-reset branch, can still change the projection but cannot change the epoch.

This is what makes a delayed event from a superseded catalog harmless: when the daemon resets unread state, the new catalog is adopted only when the confirming snapshot arrives, and until then the old epoch continues to govern validation. A socket event whose catalog ID differs from the machine's alert epoch is not eligible, and the alert controller re-checks the epoch immediately before claiming.

### Candidate lifecycle

- **No alert epoch for the candidate's catalog.** The machine has not accepted a catalog snapshot for that catalog ID, either because this is the first load or because a snapshot is still confirming a reconnect. The candidate is queued, bounded to 32 candidates per machine and 30 seconds each. At capacity the oldest queued candidate is evicted, so a burst keeps the most recent completions. A queued candidate is discarded when it expires, when the machine's capability resolves to `unsupported`, or when the machine is removed.
- **Epoch installed while candidates are queued.** Each queued candidate is validated against that epoch: a matching catalog ID makes it eligible, a different one stays queued until its own catalog is confirmed or it expires.
- **Epoch already installed.** A new candidate is validated immediately.
- **Capability renegotiation.** A socket reopen sets capability to `unknown` and re-runs negotiation; candidates are still admitted and still validate against the retained epoch, so a completion that arrives during renegotiation alerts normally instead of being discarded. Capability `unknown` therefore delays nothing. A resolution to `unsupported` clears that machine's epochs and queued candidates.

Validation is therefore independent of whether the projection exists, is loading, or has been reset by a gapped event. A candidate is eligible only when all of the following hold:

1. Its unread summary is non-null. A `null` unread payload is an acknowledgement or removal.
2. Its catalog ID equals the machine's alert epoch, re-checked immediately before claiming.
3. Its claim identity has not already been recorded, in this tab or any other.
4. The preference is enabled at admission, at queued validation, and immediately before claiming.
5. Its daemon `completedAt` satisfies the horizon and clock-skew rules below.
6. No viewer reply suppressed this completion.

HTTP snapshots, capability renegotiation, route restoration, page reload, and reconnect never create candidates. A repeated socket delivery of the same completion loses at the claim. A later active-to-idle completion has a greater completion order and different session or order, so it is a new claim identity and alerts normally.

### Completion identity

The claim, deduplication, and viewer-query identity is the structured array `JSON.stringify([machineId, catalogId, sessionId, workspacePath, completionOrder])`, the same encoding the unread controller already uses. It stays unambiguous for workspace paths containing `|`, `:`, or quotes. The selected-session identity is `JSON.stringify([machineId, sessionId, workspacePath])`, so same-named or same-ID sessions on different machines or workspaces are never conflated.

### Preference lifecycle

The enabled preference is a hard gate at four points, not a display-time filter:

1. Candidate admission. A socket message is not turned into a candidate while the preference is disabled.
2. Queued validation. A candidate queued across the initial snapshot is discarded if the preference became disabled while it waited.
3. Immediately before claiming. A candidate whose viewer query is still in flight is abandoned when the preference is disabled.
4. After the claim resolves. A claim transaction can complete after the user disables the feature, so the preference is checked once more before the notification is constructed. When it is now disabled, no notification is constructed, the committed record is retained, and its disposition is rewritten to `blocked`, so re-enabling cannot alert for that completion.

A disabled tab also never replies `viewing: true` to a viewer query. Disabling clears the pending queue and abandons in-flight queries. The preference is persisted in `localStorage` under one origin-scoped key and is read fresh from that storage at each of the four gates, on a `storage` event, on `visibilitychange`, and on `pageshow`, so toggling it in one tab takes effect in every open tab without a reload even when `BroadcastChannel` is unavailable. A disabled tab broadcasts `{ kind: "preference-changed", enabled }` on the alert channel only as a latency optimisation; correctness never depends on it. A tab that cannot read the preference treats the feature as disabled.

## Cross-tab coordination and claims

The controller owns one IndexedDB database per application origin with a single `claims` store keyed by the structured completion identity, holding `{ disposition, claimedAt, machineId, completionOrder }`, where `disposition` is `displayed`, `suppressed`, or `blocked`. Every terminal decision writes exactly one record in the same transaction that makes the decision, so a duplicate received later by any tab finds the completion already handled and does nothing.

Display requires a successful read-write transaction that reads the record and writes it when absent. The transaction is the only cross-tab mutual exclusion, so a losing tab never constructs a notification. No global, per-catalog, or per-session watermark participates in eligibility, so a completion committed in one tab can never make a different session's earlier unhandled completion ineligible.

Retention is tied to an enforced delivery horizon rather than to any capacity target. A candidate is eligible only when its daemon `completedAt` timestamp is no more than `ALERT_DELIVERY_HORIZON_MS` (24 hours) behind the browser clock and no more than `MAX_CLOCK_SKEW_MS` (5 minutes) ahead of it. An unparsable timestamp falls back to receipt time; a timestamp further ahead than the skew bound fails closed and produces no alert. Claims are retained until their `claimedAt` is older than `ALERT_DELIVERY_HORIZON_MS + 2 × MAX_CLOCK_SKEW_MS`, so every completion the horizon can admit still has its claim.

That rule set closes the delayed-delivery case. A suspended tab that resumes and processes an old socket message finds the completion outside the horizon and drops it, and no admitted completion can outlive its own claim, because claims are retained strictly longer than the horizon admits. When the browser clock runs ahead of the daemon the window shortens, and when it runs behind by more than the skew bound the future-timestamp rule suppresses delivery instead of admitting a stale completion.

The horizon is re-evaluated at three moments, not once: during candidate validation, inside the claim transaction immediately before its record is written, and once more immediately before the notification is constructed. Re-evaluating inside the transaction is what prevents a tab that was suspended between validation and serialization from displaying a completion whose claim was pruned while it slept.

Rejection before the transaction writes leaves no record at all. Rejection after the transaction has committed leaves the committed record in place and rewrites its disposition to `blocked`, the same way the preference lifecycle keeps its written record when the feature is disabled mid-flight. A committed record is therefore never deleted by a horizon check, and the two post-commit cancellations (horizon expiry and disable) behave identically: recorded, silent, and immune to a later replay.

Capacity is not a retention rule. If the browser's storage quota cannot hold a claim, the controller fails closed, reports an unavailable coordination state, and displays nothing, because displaying without a durable claim would break the at-most-once guarantee.

### Viewer suppression

Before claiming, the handling tab asks whether any live PI WEBUI window is actually showing the finished session. It broadcasts `{ kind: "viewer-query", queryId, identity }` on `pi-webui:browser-notifications:${window.location.origin}` and waits up to `VIEWER_REPLY_WINDOW_MS` (250 ms). The channel name is origin-scoped rather than mount-scoped, matching the origin-scoped claims store, so two PI WEBUI deployments mounted at different paths of one origin still coordinate viewer suppression and duplicate claims with each other. A tab replies `{ kind: "viewer-reply", queryId, viewing: true }` only when, at reply time, all of the following hold:

- The tab is not closing. A `pagehide` or `beforeunload` listener sets an internal closing flag synchronously and a closing tab never replies. A `pageshow` event with `persisted === true` clears the flag, so a page restored from the back-forward cache resumes answering.
- `document.visibilityState === "visible"` and `document.hasFocus()`.
- Its selected machine, session, and workspace path match the identity.
- The app's own active-chat predicate is true, using the same inputs that already decide whether the selected session counts as seen: the committed and ready chat identity, the obscuring-surface check, and the responsive layout check.

The responder is independent of the candidate pipeline: a tab that suppressed its own copy of a completion keeps answering queries for other tabs until it unloads. A blurring, unloading, or already-closed tab therefore cannot suppress anything for long, and a missed or failed cleanup cannot suppress a completion permanently. Any `viewing: true` reply aborts the alert before claiming and stores a `suppressed` record for that completion identity in the same store, so a later duplicate arriving in another tab after the viewer closes finds it handled and stays silent. A storage failure while writing that record suppresses the alert entirely, because the controller cannot prove the completion is handled.

A tab evaluates its own predicate first and suppresses without broadcasting when it is itself the viewer.

If `BroadcastChannel` is unavailable, viewer suppression is skipped and the claim still guarantees at-most-one display; Settings reports that cross-window suppression is unavailable in this browser.

If the database cannot be opened, upgraded, or written, the controller reports an unavailable coordination state, displays nothing, and leaves unread projection and session operation untouched.

## Names and fallbacks

The selected machine's session catalog may provide a session name. Project and workspace catalogs may resolve the event workspace path to project and workspace names. If a session name is unavailable, the alert uses a short session identifier. If project metadata is unavailable, it uses the workspace basename when available and otherwise “Project”. No lookup failure blocks alert delivery.

The browser alert title identifies the session and project, and the body says “Session is idle”. The wording does not claim that the work succeeded, failed, or was cancelled.

## Click navigation

A click first focuses the existing PI WEBUI browsing context. It never navigates from the event payload alone: the event carries a machine, session, and workspace path, while a route needs project and workspace identifiers.

`resolveAlertTarget` returns either `{ ok: true, machineId, projectId, workspaceId, sessionId }` or `{ ok: false, reason }` with the reasons `machine-unavailable`, `workspace-missing`, or `session-missing`. Resolution proceeds in order:

1. If the alert's machine is not the selected machine, select it through the existing machine controller and await its runtime and project catalog load. An offline or unknown machine ends resolution with `machine-unavailable`.
2. Resolve the workspace by exact path within that machine's catalog, loading the workspace lists of projects that are not yet catalogued. Candidate projects are considered in catalog order, bounded to one load pass per project.
3. Confirm the session is present in that workspace's session list, matched by ID and workspace path.

Only a resolved target navigates. Navigation first dismisses what is covering the chat: it closes the settings dialog, removes the `settings` query parameter, closes any other dialog that obscures chat, and selects the chat view rather than a workspace tool. It then selects the resolved machine, the resolved project through the project selection path, the workspace with the session ID, and writes the route through the established route writer so dynamic values stay properly encoded. Because `selectWorkspace` neither changes the selected project nor leaves a tool view, both are set explicitly, and the resulting machine, project, workspace, and session are compared with the resolved target before the route is written; a mismatch or a target that disappeared mid-navigation produces the unavailable-target notice instead of a partial route. The alert closes in every outcome.

## Deliverables

The implementation also updates user-facing documentation and adds a Changeset:

- `docs/faq.html` gains a "Browser notifications" entry covering opt-in, permission denial, insecure contexts, delivery limits, and the distinction from the session notification inbox.
- A `.changeset/<slug>.md` fragment records the new user-visible feature.
- `README.md` stays unchanged because the quick-start path and top-level product story do not change.

## Error handling and availability

- A missing Notification API or insecure context displays an unavailable status and never requests permission.
- Permission remains `default`, `granted`, or `denied` as reported by the browser. Permission is requested only on explicit enable.
- A denied permission keeps the preference disabled and explains the browser-level restriction.
- IndexedDB failure or lack of the claim store prevents display and is reported in the settings status. It does not affect unread projections.
- A missing `BroadcastChannel` disables cross-window viewer suppression but keeps claim-based duplicate prevention; Settings states that limitation.
- A completed claim cancelled after commit — by horizon expiry or by disabling the feature — stays recorded with disposition `blocked` and produces no notification.
- A candidate received while the feature is disabled, or after it is disabled, produces no notification and no claim.
- A completion received while a machine's capability is being renegotiated is admitted and may alert; one received after the machine resolves to `unsupported` is discarded with that machine's queued candidates.
- A claim that cannot be stored because the origin's quota is exhausted fails closed: no notification is displayed, and the coordination state is reported as unavailable.
- Notification constructor, display, or click failures are caught and reported locally. Realtime processing continues.
- The preference is local to the browser profile and application origin. Storage access failures are handled without breaking PI WEBUI.
- IndexedDB coordination failure is reported separately from permission state, because the two restrictions have different remedies.
- Alerts require an open, connected PI WEBUI page. Closed, suspended, disconnected, or offline pages cannot receive live completions. No server push delivery is promised.

## Architecture

- Add a browser-alert preference and capability helpers isolated from extension/session inbox preferences.
- Add a browser completion alert controller with injectable Notification construction, document visibility/focus, claim store, viewer-query channel, and click-navigation dependencies.
- Extend the unread event seam so the alert controller receives each live socket completion with its machine identity at receipt time, while `SessionUnreadController` keeps projection, acknowledgement, and event ordering authoritative.
- Have the app supply the active-chat predicate already used for read acknowledgement, so viewer replies describe what is actually visible instead of what is merely selected.
- Integrate the controller into `PiWebUiApp` using the same machine/session state and catalog information used by current navigation.
- Add a `notifications` settings route and a dedicated browser notification settings panel. Keep the existing session inbox in ChatView and its controller unchanged.
- Use application-relative browser routes and the established route writer for navigation. Do not add server or session-daemon protocol changes.

## Verification strategy

Unit tests cover the new preference, permission timing, unsupported and denied states, socket-receipt candidates, snapshot and reconnect silence, `completion_during_capability_renegotiation_is_admitted`, `capability_unsupported_discards_queued_candidates`, a candidate queued across the initial snapshot and validated when the epoch lands, candidate expiry, `candidate_older_than_horizon_is_rejected`, `queue_overflow_evicts_oldest_and_alerts_newest`, a gapped live event, an event from a superseded epoch before and after an asynchronous delay, reverse-order commits of two different sessions in two tabs, and null/removal events. They also cover local and remote viewer suppression, a query arriving while the answering tab is unloading, a page restored from the back-forward cache, a delayed blur publication, a tab whose chat is hidden behind a workspace tool, settings dialog, and modal, mobile tool-view layout, same-session identity across machines/workspaces, pipe-bearing workspace paths, name fallbacks, the claim race, a claim transaction that resolves after the feature is disabled, daemon timestamps ahead of and behind the browser clock, a replay after more than two thousand completions inside the horizon, tab closure after a claim, notification errors, enabling and disabling the preference across two tabs, target resolution for selected and non-selected machines, every `resolveAlertTarget` failure reason, and unavailable targets.

A negative isolation test feeds `notifications.inbox` and `notifications.summary` events plus content-bearing prompt, tool-output, and extension fixtures into the browser-alert controller, then asserts that no candidate and no claim were created and that constructed titles and bodies contain only the session name, project name, and the approved idle wording.

Boundary tests assert exact values rather than loose inequalities: a completion aged exactly `ALERT_DELIVERY_HORIZON_MS` is eligible and one millisecond older is not; a timestamp exactly `MAX_CLOCK_SKEW_MS` ahead is eligible and one millisecond further ahead fails closed; a quota failure constructs no notification and reports the coordination state as unavailable. The deferred-claim test disables the preference before the transaction commit, asserts no notification plus a retained record, re-enables, redelivers the same completion, and asserts it stays silent. The viewer-replay test suppresses through a remote viewer reply, closes that viewer, then redelivers the completion in another tab and asserts it stays silent.

Retention and re-evaluation are proven by direct store inspection rather than by the absence of a notification, because a horizon check alone could also explain that absence. The retention test reads the store and asserts three states of one record: present while its age is one millisecond below the retention bound, still present at exactly the bound, and removed by an explicit pruning pass at one millisecond beyond it, with no other record removed by that pass.

Three named suspension tests advance a fake clock between the stages of a single candidate. `suspension_between_validation_and_transaction` advances past the horizon after validation and before the transaction write, and asserts zero notifications and no record. `suspension_between_commit_and_construction` advances past the horizon after the commit and before construction, and asserts zero notifications and a retained record whose disposition is `blocked`. `suspension_across_pruning_and_resume` prunes the candidate's record while it is suspended, resumes it after the horizon, and asserts zero notifications and no newly written record.

Those tests pin the checks one-to-one. Removing the validation-time horizon check fails `candidate_older_than_horizon_is_rejected`, because an out-of-horizon completion would enter the pipeline at all. Removing the transaction-time check fails `suspension_between_validation_and_transaction`, because a record would be written, and fails `suspension_across_pruning_and_resume`, because a new record would be written after the suspended candidate resumes; that second test fails on its record assertion, not on a notification count, since the pre-construction check still suppresses the display. Removing the pre-construction check fails `suspension_between_commit_and_construction`, because a notification would be constructed. Removing the post-commit `blocked` rewrite fails the same test's disposition assertion.

Settings tests verify the new standalone route and panel, the explicit separation statement, permission and delivery feedback, and the test-notification action. A click-activation test opens Settings and a workspace tool view, activates an alert, and asserts that both are dismissed, the chat view is selected, and the written route names the resolved machine, project, workspace, and session. Existing session inbox tests continue to verify their `notifications.*` events and message content independently.

A real-browser check covers permission gating, actual desktop notification construction and click behaviour, and focus/navigation behaviour, using these Chromium scenarios:

- Two tabs, one focused on the completed session and one backgrounded: no alert is displayed anywhere.
- Two background tabs receiving the same completion: exactly one alert is displayed.
- A focused viewer whose chat is hidden behind a workspace tool: exactly one alert is displayed.
- The focused viewer blurs or closes just before the completion arrives: exactly one alert is displayed.
- A deferred event from a superseded catalog epoch: no alert is displayed.

It also confirms the feature's origin-scoped storage and nested application path behaviour.

## Operational impact

The design consumes existing web/API and session-daemon unread events. It introduces no session-daemon-loaded code and no daemon protocol change, so it does not require a manual session-daemon restart. The UI/API process reload path is sufficient after implementation.
