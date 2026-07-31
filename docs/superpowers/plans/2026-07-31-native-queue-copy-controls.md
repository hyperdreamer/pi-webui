# Native Pi Queue Copy Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Pi's Steered and Follow-up queues as separate groups and add individual and aggregate copy controls without changing Pi's native queue behavior.

**Architecture:** Keep `SessionStatus.queuedMessages` and the existing global clear handler unchanged. Add pure presentation helpers in `ChatView.ts` to partition server messages by `kind` and format the live queues for aggregate copying; keep `ChatView` as the thin clipboard/rendering boundary. Reuse `writeClipboardText` and add only client-side styles and a patch Changeset.

**Tech Stack:** TypeScript, Lit, Vitest, existing `writeClipboardText` clipboard adapter, CSS-in-TypeScript in `src/client/src/components/shared.ts`, Changesets.

## Global Constraints

- Pi remains the sole authority for live queue state and delivery timing.
- Do not add Combine, individual Remove/Undo/Restore, per-type Clear, queue editing, queue reordering, client-side shadow state, server routes, or session-daemon changes.
- Render live messages as **Steered** (`Sent together at the next turn`) and **Follow-up** (`Sent together after the agent finishes`) groups; omit empty groups.
- Keep **Queued until session starts** as one separate client-local section and provide only the individual Copy action there.
- Every visible queued message has an accessible, non-destructive Copy action that copies its displayed text.
- Show **Copy all queues** when both live Pi queue types are non-empty; show **Clear all queues** immediately after it only when the clear capability/handler are available.
- Aggregate copy includes only live Pi queues, preserves group/order, and uses blank lines between messages and groups.
- Do not edit `CHANGELOG.md`; add one patch Changeset for the user-visible feature.
- This is client/UI-only; no manual `pi-webui-sessiond.service` restart is needed.

---

### Task 1: Queue presentation model and aggregate-copy formatter

**Files:**
- Modify: `src/client/src/components/ChatView.ts:78-89, 134-136` — extend queue section metadata, partition live messages, and define pure action/formatting helpers.
- Modify: `src/client/src/components/ChatView.test.ts:105-252` — replace flattened-queue expectations and add pure helper coverage.

**Interfaces:**
- Consumes: `QueuedSessionMessage[]` from `SessionStatus.queuedMessages` and the existing client-local queued-message array.
- Produces: `QueuedMessageSection` values with `source: "client" | "server"`, optional `kind: "steer" | "followUp"`, `heading`, `detail`, and ordered `messages`; `chatQueuedMessageSections`; `chatQueuedSectionsHaveBothServerKinds`; `chatQueuedSectionsShowClearAction`; and a pure `chatQueuedMessagesCopyText` formatter for Task 2.

- [ ] **Step 1: Write the failing pure-helper tests.**

Update `describe("chatQueuedMessageSections")` so a fixture containing one client message, two Steered messages, and one Follow-up message expects four sections in this order: the unchanged client section, a `server`/`steer` section headed `Steered` with detail `Sent together at the next turn`, and a `server`/`followUp` section headed `Follow-up` with detail `Sent together after the agent finishes`. Assert that each section preserves the source-order of messages within its own kind and that empty kinds are omitted.

Add pure tests for the two-live-kind decision, clear/action decision, and formatter with these cases:

```typescript
expect(chatQueuedSectionsHaveBothServerKinds([])).toBe(false);
expect(chatQueuedSectionsHaveBothServerKinds(
  chatQueuedMessageSections([], [
    { kind: "steer", text: "adjust" },
    { kind: "followUp", text: "then inspect" },
  ]),
)).toBe(true);
expect(chatQueuedSectionsHaveBothServerKinds(
  chatQueuedMessageSections([], [{ kind: "steer", text: "adjust" }]),
)).toBe(false);
expect(chatQueuedSectionsShowClearAction([], true, true)).toBe(false);
expect(chatQueuedSectionsShowClearAction(
  chatQueuedMessageSections([], [
    { kind: "steer", text: "adjust" },
    { kind: "followUp", text: "then inspect" },
  ]),
  true,
  true,
)).toBe(true);
expect(chatQueuedSectionsShowClearAction(
  chatQueuedMessageSections([], [{ kind: "steer", text: "adjust" }]),
  true,
  true,
)).toBe(false);
expect(chatQueuedSectionsShowClearAction(
  chatQueuedMessageSections([], [
    { kind: "steer", text: "adjust" },
    { kind: "followUp", text: "then inspect" },
  ]),
  false,
  true,
)).toBe(false);

expect(chatQueuedMessagesCopyText(
  chatQueuedMessageSections([], [
    { kind: "steer", text: "adjust" },
    { kind: "steer", text: "keep the tests" },
    { kind: "followUp", text: "then inspect" },
  ]),
)).toBe([
  "Steered queue",
  "adjust",
  "",
  "keep the tests",
  "",
  "Follow-up queue",
  "then inspect",
].join("\\n"));
```

Also assert that the aggregate formatter ignores the client-local section when both client and server fixtures are supplied, and returns an empty string when no live server sections exist.

- [ ] **Step 2: Run the focused test file and verify the failures are feature failures.**

Run:

```bash
npm test -- src/client/src/components/ChatView.test.ts
```

Expected: the new expectations fail because the current helper still returns one flattened server section and no aggregate formatter/action rule exists. Fix only test typos if the failure is an import or syntax error; do not implement production behavior yet.

- [ ] **Step 3: Implement the minimal presentation helpers.**

Change `QueuedMessageSection` to carry an optional `kind` field. Make `chatQueuedMessageSections(clientQueued, serverQueued)` return:

```typescript
[
  clientQueued.length === 0 ? undefined : {
    source: "client",
    heading: "Queued until session starts",
    detail: "Will send once the backend session is ready",
    messages: clientQueued,
  },
  ...server sections for "steer" then "followUp" when their filtered arrays are non-empty,
].filter(...)
```

Use the exact live group details `Sent together at the next turn` and `Sent together after the agent finishes`. Preserve the order returned by Pi within each filtered group. Do not mutate either input array.

Add `chatQueuedSectionsHaveBothServerKinds(sections)` returning true only when both non-empty server kinds are present. Replace the section-level clear predicate with `chatQueuedSectionsShowClearAction(sections, canClearServerQueue, hasClearHandler)`, returning true only when `chatQueuedSectionsHaveBothServerKinds(sections)`, `canClearServerQueue`, and `hasClearHandler` are all true. Keep the existing exported name if that minimizes call-site churn, but its first argument must be the complete section list so a single queue can no longer expose the global clear action.

Add `chatQueuedMessagesCopyText(sections)` that filters to non-empty `source: "server"` sections, maps `steer` and `followUp` to the exact copy headings `Steered queue` and `Follow-up queue` without changing the visual headings, and joins each section as `${copy heading}\\n${message texts joined by "\\n\\n"}`, then joins sections with `\\n\\n`. It must not include the client-local startup section and must return `""` when no live sections exist.

- [ ] **Step 4: Run the focused tests and verify the pure seam is green.**

Run:

```bash
npm test -- src/client/src/components/ChatView.test.ts
```

Expected: the updated queue-section, action-visibility, and formatter tests pass; unrelated existing ChatView tests remain green.

- [ ] **Step 5: Commit the presentation-model task.**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts
git commit -m "feat: partition native queued messages by type"
```

---

### Task 2: ChatView copy controls, styling, and release fragment

**Files:**
- Modify: `src/client/src/components/ChatView.ts:913-939` — render separate sections, per-message Copy controls, and shared Copy all/Clear all actions.
- Modify: `src/client/src/components/ChatView.test.ts:254-271` and nearby queue tests — cover rendered labels and handler wiring.
- Modify: `src/client/src/components/shared.ts:619-628` — style queue action rows and copy buttons.
- Create: `.changeset/native-queue-copy-controls.md` — user-facing patch release note.

**Interfaces:**
- Consumes: Task 1's `QueuedMessageSection[]`, `chatQueuedSectionsShowClearAction`, and `chatQueuedMessagesCopyText`; existing `writeClipboardText`, `onClearServerQueue`, and `canClearServerQueue` properties.
- Produces: rendered individual Copy buttons for all queued sections; live-only `Copy all queues` and `Clear all queues` controls with the specified visibility/order.

- [ ] **Step 1: Write failing ChatView interaction/render tests.**

Extend the existing queue wiring tests with these observable cases:

1. With one Steered message only, `renderQueuedMessages(view)` contains `Steered`, `Sent together at the next turn`, an individual Copy control with an accessible label containing `Copy steered message 1`, and no `Copy all queues` or `Clear all queues` action.
2. With both Steered and Follow-up messages, `renderQueuedMessages(view)` contains both group headings/details and the shared action markers in this order: `Copy all queues` before `Clear all queues`.
3. Set `view.canClearServerQueue = true` and inject `onClearServerQueue`; extract the individual `Copy steered message 1`, `Copy all queues`, and `Clear all queues` handlers from the template. At the top of `ChatView.test.ts`, add `vi.mock("../clipboard", () => ({ writeClipboardText: vi.fn(async () => true) }));` and import the mocked `writeClipboardText`; clear `vi.mocked(writeClipboardText)` before each copy assertion. Assert that the individual handler receives the row text, the Copy all handler receives the Task 1 formatted live-queue text, and the clear handler invokes `onClearServerQueue` exactly once.
4. With only a client-local startup message, render its existing section and an individual Copy control, but no aggregate live-queue action.

Keep the test focused on public observable labels and callback effects; use the existing template-handler extraction escape hatch only because this suite runs without a DOM harness.

- [ ] **Step 2: Run the focused tests and verify they fail for missing UI behavior.**

Run:

```bash
npm test -- src/client/src/components/ChatView.test.ts
```

Expected: the new render/action tests fail because the current server queue is still flattened, the row has no Copy control, and the existing action is labelled `Clear queue` rather than the new shared action pair.

- [ ] **Step 3: Implement the minimal ChatView controls.**

Update `renderQueuedMessages()` to derive `sections = chatQueuedMessageSections(this.clientQueuedMessages, this.status?.queuedMessages ?? [])`, identify the live server sections, and compute `showCopyAll = chatQueuedSectionsHaveBothServerKinds(serverSections)` plus `showClearAll = chatQueuedSectionsShowClearAction(sections, this.canClearServerQueue, this.onClearServerQueue !== undefined)`. Render the client section separately, render a shared live action row when `showCopyAll` is true, then render the Steered and Follow-up sections.

Change the global button label to `Clear all queues` and keep its callback wired to `handleClearServerQueue`. Render `Copy all queues` immediately before it; if clearing is unavailable, render Copy all by itself. Neither aggregate action may appear for only one live kind or for client-local startup messages.

For each queued row, render a semantic row header containing the existing kind/index label and an icon-only button with:

```html
aria-label="Copy steered message 1"
 title="Copy message"
```

Use `message.kind === "steer" ? "steered" : "follow-up"` in the accessible label. The handler must stop propagation and call `writeClipboardText(message.text)` without modifying `status`, `clientQueuedMessages`, or any queue count. Do not add a new copied-state or queue identity; the button remains labelled Copy after the operation.

Add a bound `handleCopyAllQueuedMessages` callback and a small `copyAllQueuedMessages()` method that calls `writeClipboardText(chatQueuedMessagesCopyText(serverSections))`. Reuse the existing clipboard adapter and do not add a server route or shadow queue state. If the adapter reports failure, leave the UI/queue unchanged.

- [ ] **Step 4: Add focused queue styles and the Changeset.**

In `src/client/src/components/shared.ts`, keep the existing warning-card visual language and add only the layout needed for:

- a shared `.queued-actions` flex row with wrapping for narrow widths;
- a `.queued-message-header` row that keeps the kind label and Copy button aligned;
- a compact `.queued-copy-button` matching the existing session-info copy affordance; and
- visible hover/focus-visible states using existing border/accent variables.

Do not change unrelated message, session, or mobile layout styles.

Create `.changeset/native-queue-copy-controls.md` with:

```md
---
"@hyperdreamer/pi-webui": patch
---

Show Steered and Follow-up queues separately and add individual and aggregate copy controls for queued messages.
```

- [ ] **Step 5: Run focused tests and type/lint checks.**

Run:

```bash
npm test -- src/client/src/components/ChatView.test.ts
npm run typecheck
npx eslint src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/shared.ts
```

Expected: all focused tests pass, TypeScript exits successfully, and ESLint reports no errors.

- [ ] **Step 6: Commit the UI task.**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/ChatView.test.ts src/client/src/components/shared.ts .changeset/native-queue-copy-controls.md
git commit -m "feat: add queued message copy controls"
```

---

## Final verification

After both task commits, run the complete required checks from the feature spec:

```bash
npm run typecheck
npm run lint
npm run knip
npm test
git diff --check
npm run build
```

Confirm with `git status --short` that the feature worktree is clean, confirm the Changeset is present, and confirm no files under `src/server/sessiond.ts` or session runtime ownership changed. The feature remains client/UI-only, so do not restart the session daemon.
