# Starter screen notice channel

**Date:** 2026-08-03
**Status:** Proposed design

## Problem

`state.error` carries two unrelated jobs at once. It is the foreground error banner rendered in `<main>` (`PiWebUiApp.ts:3800`), and it is an input to screen selection: `shouldShowSessionStartScreen()` returns false unless `state.error === ""` (`PiWebUiApp.ts:2149-2155`).

Any code that reports a transient failure through `setState({ error })` therefore also unmounts the new-session start screen. That screen owns the composer, the model-policy pill, the tier menu, and the row reason — the controls a user needs to repair the very condition being reported. The banner names a fix the user can no longer perform in place, and it has no dismiss control; recovery requires re-selecting a workspace, which runs `resetWorkspaceScopedState()` and clears `error` (`appState.ts:126-148`).

Three call sites are affected today:

1. `startSessionAndOpenChat()`'s start failure (`PiWebUiApp.ts:1998`).
2. `loadStarterSessionDefaults()`'s catch (`PiWebUiApp.ts:3186`).
3. `sendPrompt()`'s starter `startSessionWithPrompt` rejection (`PiWebUiApp.ts:3223`).

A fourth case was already worked around rather than fixed. Finding FR-1 of the persisted-starter-preference branch reported the starter *policy block* through `setState({ error })` and unmounted the composer; the fix introduced a dedicated `starterModelPolicyStartBlocked` flag plus a notice rendered inside `renderSessionStartScreen()` (`PiWebUiApp.ts:360`, `:1982`, `:2176`). That closed the unmount, and its own code comment states the reason plainly: "`state.error` cannot carry it".

But confining the notice to the start screen created finding FRR-1, parked as Minor: when a session is selected in the same workspace, `render()` takes the `state.selectedSession` branch (`PiWebUiApp.ts:3806`), the start screen is not rendered, and setting the flag produces no visible output anywhere. The starter draft survives session selection, because `handleWorkspaceChange()` resets starter state only when the workspace id actually changes, so the block is live while nothing renders it. "New session" from navigation (`PiWebUiApp.ts:1965`) or the action palette (`PiWebUiApp.ts:2626`) is then completely inert.

So the workaround traded an unmount for silence, in one path, for one condition. The general defect remains: there is no channel for "something about the starter failed" that neither unmounts the start screen nor disappears when the start screen is not the current view.

## Goals

- Give starter-originated notices a channel independent of screen selection.
- Keep the start screen mounted, with its repair controls reachable, whenever a starter condition is reported.
- Make a starter notice visible whether or not the start screen is the current view, so no invocation path is silent.
- Close FRR-1 and the three `setState({ error })` unmounting paths with one mechanism rather than four workarounds.
- Preserve every current blocking guarantee: an unavailable remembered tier stays selected and blocks Start with no substitution.

## Non-goals

- Redesigning error handling outside the starter and session-start paths. `state.error` keeps serving machine dialogs, workspace deletion, terminal command failures, and remote route restore.
- Changing the persisted starter preference contract, its store, its capability gating, or the daemon.
- Changing what counts as a blocked starter policy. `starterModelPolicyInputs().status.blockedReason` and `starterModelPolicyError()` keep their current semantics and priority order.
- Adding a notification centre, a toast system, or a new dependency.

## Domain model

Two distinct kinds of message are currently conflated:

A **screen-selection blocking error** means the app cannot present the normal view for the current selection. It is correct for `shouldShowSessionStartScreen()` to consult it: if sessions could not be loaded, the start screen would be lying about an empty workspace. This is what `state.error` should mean, and the four non-starter writers already use it that way.

A **starter notice** is a message about a starter action that failed or was refused, while the starter context itself remains valid and repairable. It must never influence which screen is shown, because the screen it would suppress is where the repair happens.

The distinction is not about severity. A start-request rejection is serious, and it is still a starter notice: the workspace loaded fine, the composer is intact, and retrying is the obvious next step.

## Proposed design

### One starter notice channel

Replace the boolean `starterModelPolicyStartBlocked` with a single starter notice held outside `AppState`, so it cannot reach `shouldShowSessionStartScreen()`:

```ts
type StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed";

interface StarterNotice {
  kind: StarterNoticeKind;
  /** Fixed text for failures; omitted when the reason is read live. */
  message?: string;
  /** Machine and workspace the notice belongs to. */
  scope: { machineId: string; workspaceId: string };
}
```

`kind: "policy-blocked"` carries no `message` and reads its text from the live `starterModelPolicyInputs()?.status.blockedReason` at render time. This preserves the property the FR-1 fix established and the final re-review verified: repairing the ladder or choosing a valid tier retires the notice on the next render, with no stale string. A captured copy would reintroduce exactly that staleness.

`"start-failed"` and `"defaults-failed"` carry fixed `message` text, because the failure they describe is a past event with no live source to re-read.

The notice is scoped. A notice raised for one machine/workspace must not appear after switching to another, which is the same guard `resetStarterModelPolicyForScopeChange()` already applies to the draft (`PiWebUiApp.ts:1603`).

### Rendering in both views

Render the notice in `<main>`, as a sibling of the `state.error` banner rather than inside `renderSessionStartScreen()`:

```ts
${state.error ? html`<div class="error">${state.error}</div>` : null}
${this.renderStarterNotice(state)}
```

`renderStarterNotice()` returns nothing unless the notice's scope matches the current machine and workspace, and — for `"policy-blocked"` — unless a live `blockedReason` still exists. Because it sits outside the `state.selectedSession` / start-screen branch, it is visible in both views. That closes FRR-1 directly: "New session" with an unusable remembered tier reports its reason whether or not a session is selected.

Keep `role="alert"` and the existing `.session-start-block-notice` styling contract, renamed to `.starter-notice` to match its wider role.

### Redirecting the three unmounting writes

| Site | Today | Proposed |
| --- | --- | --- |
| `startSessionAndOpenChat()` catch (`:1998`) | `setState({ error: String(error) })` | `"start-failed"` starter notice |
| `sendPrompt()` starter rejection (`:3223`) | `setState({ error: String(error) })` | `"start-failed"` starter notice |
| `loadStarterSessionDefaults()` catch (`:3186`) | `setState({ error: String(error) })` | `"defaults-failed"` starter notice |

All three already carry a scope guard, so the notice inherits the staleness protection they have now.

The defaults-load case is the clearest illustration of the current bug: failing to load starter defaults unmounts the screen whose purpose is to let the user pick a model, and Pi's own defaults would still have started a session.

### Clearing

The notice clears on:

- a successful equivalent of the failed action — a start that begins, or a defaults load that resolves;
- an explicit starter edit, matching today's `setStarterModelPolicyDraft()` reset (`PiWebUiApp.ts:3247`);
- machine or workspace change, alongside the draft reset (`PiWebUiApp.ts:1603`);
- for `"policy-blocked"`, the live gate alone once `blockedReason` becomes undefined.

The final re-review's standing recommendation is adopted: clear the flag whenever `blockedReason` becomes undefined, so a `"policy-blocked"` notice means strictly "the user's last Start attempt was refused" and cannot reappear after an external repair without a fresh attempt.

`shouldShowSessionStartScreen()` is left exactly as it is. That is the point of the design: it keeps consulting `state.error`, which now only ever holds screen-selection blocking errors.

## Failure behavior

- A starter notice never blocks Start on its own. Only `blockedReason` does, through the existing `.sendDisabled` binding and `starterModelPolicyBlocksStart()`.
- A blocked starter policy still refuses both start paths, keeps the tier selected, and substitutes nothing.
- Preference read and write failures keep their current non-blocking behavior and their current priority in `starterModelPolicyError()`.
- If both a screen-selection error and a starter notice are live, both render. They describe different things, and suppressing either would hide information the user needs.

## Verification strategy

The load-bearing risk is regression in both directions: a notice that unmounts the screen again, or a screen that stays mounted while the notice is invisible. Both need pinning.

- A blocked direct start keeps the start screen mounted, with the composer bound, the tier still selected, and the reason rendered.
- A blocked direct start with a session selected in the same workspace still renders the reason — the FRR-1 case, which no current test covers.
- `state.error` is not written by any starter path: assert `appState(app).error === ""` after each of the three redirected sites.
- A failed starter defaults load keeps the start screen mounted and reports the failure.
- A failed start request keeps the composer mounted and its draft intact for retry.
- Repairing an invalid tier retires the notice with no stale text; an external catalog repair with no starter edit also retires it.
- A notice raised in one workspace does not render after switching workspace or machine.
- A genuine screen-selection error still suppresses the start screen, so the `shouldShowSessionStartScreen()` contract is unchanged.

Each new assertion must be proven falsifiable by mutation: restoring a `setState({ error })` write must fail the corresponding test, and deleting the notice render must fail the visibility tests. A test that passes against both the old and new implementation pins nothing — that is precisely how FRR-1 reached the final gate.

Run the focused client tests, then `npm run typecheck`, `npx eslint` on changed files, and `npx knip`. Because this touches app-wide rendering and screen selection, finish with `npm run verify`.

## Alternatives rejected

### Make `shouldShowSessionStartScreen()` ignore a starter-originated error

Encoding provenance into `state.error` and filtering on it keeps one overloaded field and adds a second concept to it. Every future writer would have to know which flavour it is producing, and getting it wrong reintroduces the unmount silently.

### Keep the notice inside the start screen and clear `selectedSession` first

Having "New session" clear the selected session so the start screen is what the user lands on also closes FRR-1, but it makes a control that reports a refusal navigate away from the current session as a side effect. A refusal should not move the user.

### A general toast or notification system

Right shape, disproportionate for three call sites and one flag. It would also need its own lifetime, stacking, and dismissal semantics — new surface for a fix whose whole point is removing ambiguity. Worth revisiting only if unrelated features start wanting the same channel.

### Leave FRR-1 alone

Defensible in isolation: it is Minor, non-load-bearing, and the reason reappears on the start screen. But it shares a root cause with three live unmounting paths, one of which (`loadStarterSessionDefaults`) breaks a first-run scenario. Fixing them separately means four workarounds where one channel suffices.

## Acceptance criteria

1. No starter-originated path writes `state.error`.
2. The start screen stays mounted, with repair controls reachable, for every starter notice.
3. A blocked start reports its reason whether or not a session is selected in the same workspace.
4. A `"policy-blocked"` notice reads its text live and retires when the condition is repaired, with no stale string.
5. Notices are scoped and do not leak across machine or workspace changes.
6. An unavailable remembered tier still blocks Start with no substitution.
7. A failed starter defaults load no longer prevents using the composer.
8. `shouldShowSessionStartScreen()` still suppresses the start screen for genuine screen-selection errors.
9. Every new assertion is proven falsifiable by mutation.
10. `npm run verify` passes.

## Notes for the plan

- The three redirected sites and the notice channel are one cohesive change; splitting them across tasks would leave `state.error` writes and the new channel live at the same time.
- `.session-start-block-notice` in `shared.ts:197` is renamed, so any test anchoring on that class updates with it.
- `docs/config.md` describes user-visible starter behavior. If the wording about what a block shows changes, `docs/config.html` needs the same claims.
- This is a user-visible bug fix and needs a patch Changeset. Do not hand-edit `CHANGELOG.md`.
- No `src/server/` change is expected, so no session daemon restart should be required.
