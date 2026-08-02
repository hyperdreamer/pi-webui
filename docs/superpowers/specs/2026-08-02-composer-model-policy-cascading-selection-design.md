# Composer model policy cascading selection

## Problem

The composer model policy control is a deferred draft form: the user edits Mode,
Tier, and the exact model/thinking pair, then commits with Save. Two things about
that are unsatisfying in the composer context.

Save is redundant ceremony for what is conceptually a selection. The control sits
inline in the composer action row, next to controls that apply immediately.

More importantly, a first-run install renders no control at all.
`starterModelPolicyInputs()` returns `undefined` when `starterExactSelection()`
cannot build a tuple from machine defaults, which happens when the machine
reports no default model or an empty thinking level. A user with nothing
configured sees no policy control and no explanation.

This design replaces the Save button with completion-triggered application, and
gives every unconfigured state a deterministic, explainable resolution.

## Approach

Keep the existing draft object and the existing pure helpers. Change only *when*
a draft is submitted, and *what* seeds a draft that has no history.

The unit of application stays the whole tuple.
`sessionModelPolicyUpdateFromDraft()` already returns a discriminated union —
`{mode: "exact", exact}` or `{mode: "tiered", tier}` — and returns `undefined`
rather than a partial update when the draft is invalid. That function is the
gate: an apply fires exactly when it returns a defined value, and never
otherwise.

Two alternatives were rejected.

*Apply on every change event.* In Exact mode the tuple spans two controls.
`updateDraftExactModel()` deliberately sets `thinkingLevel: ""` when the incoming
model does not support the outgoing level, so at the moment the model changes the
tuple is intentionally incomplete. Submitting it would fail server validation and
could leave a `MODEL_POLICY_BLOCKED` runtime block, which is daemon-owned and
survives reload and close/reopen. A routine model change would break the session.

*Keep Save, only restyle it.* Does not address the first-run gap, which is the
substantive defect.

## Mechanism

### Completion-triggered application

Tiered mode applies on tier selection. One tier value resolves to a complete
model/thinking pair from the ladder, so the tuple is complete at that instant.

Exact mode updates the draft locally on model change and applies once model *and*
a supported thinking level are both set. When the incoming model supports the
current level, `updateDraftExactModel()` preserves it and the apply still fires
on a single interaction. Two interactions are required only when the level
genuinely cannot carry over — precisely the case where an immediate apply would
have failed.

Exact-mode applies are coalesced behind a short trailing delay, so repeatedly
cycling the thinking-level dropdown issues one policy write rather than several
against a live session. Tiered applies are not coalesced; a tier click is a
single deliberate act.

Mode changes route through `selectDraftExact()` / `selectDraftTiered()` rather
than assigning `mode` directly, so mode and tuple stay in one draft object and a
mode switch can never produce Tiered-with-no-tier or Exact-with-an-unsupported
level.

### Resolution chain

Draft seeding resolves in priority order. Each case is deterministic; no case
invents a model.

1. **Persisted policy exists** → restore it. Already implemented: the stored
   `SessionModelPolicy` legitimately retains a remembered canonical `tier` while
   in Exact mode, and `selectDraftExact()` / `selectDraftTiered()` spread the
   previous draft, so Tier and the exact tuple both survive a mode switch.
2. **Active session, nothing persisted** → the session's live confirmed tuple,
   via `exactSelectionFromSession()`. This is existing behavior
   (`piSessionService.ts:3438`) and is already correct: the tuple is known-good
   and already in effect.
3. **Starter with usable machine defaults** → seed from those defaults. Existing
   behavior via `starterExactSelection()`.
4. **Starter with no usable defaults** → render the control with empty
   selections. Model shows `Select a model…`, thinking level shows
   `Select a thinking level…`, start is blocked with a reason. When the catalog's
   `models` array is also empty, the reason names the real problem: no models are
   configured on this machine. `starterModelPolicyInputs()` stops requiring
   `starterExactSelection()` to return a tuple.
5. **Tiered with a usable ladder and no tier chosen** → pre-select `standard` in
   the draft. `standard` is not privileged in the data model, so this applies
   only when that row is valid; otherwise the draft stays unset and case 7
   governs.
6. **Catalog still loading** → the selector shows `Unknown`, and the live
   confirmed tuple stays visible wherever one exists. `ladderValid` remains
   `catalog === undefined || catalog.valid`, so an unknown catalog never asserts
   a configuration error.
7. **Tiered unresolvable** → `blockedReason` with the specific cause, repairable
   by switching to Exact or fixing the ladder.

### Blocking

Blocking is keyed to ambiguity about the live tuple, not to a missing option
list. Send or start is blocked in exactly three cases:

- `MODEL_POLICY_BLOCKED` from the runtime adapter, where the daemon cannot prove
  which tuple is live. Clears only through a successful explicit application.
- Tiered mode whose tier cannot resolve.
- Case 4, a starter with no selection yet.

Send is **not** blocked when only the catalog fetch failed while a session holds
a valid confirmed tuple. The catalog is a separate per-machine request
(`modelTiersApi.settings`) from the confirmed tuple, which arrives with session
status. A transient catalog failure leaves the session unambiguous and prompting
normally. Blocking there would also be unrecoverable: the catalog *is* the list
of selectable models, so "pick a valid model" would be unreachable. That state
renders the live tuple with the selector marked unavailable and a Retry.

`Unknown` is reserved for a genuinely in-flight load. It is not used for a failed
catalog, and not used in place of a per-row `reason` or `configError`, because
collapsing those into one label discards the repair path.

## Consequences

Save and Cancel leave the panel. Dismissal is by the existing close routes, all
of which funnel through `close()` and fire `onClose`.

An unconfigured first-run install renders an actionable form instead of nothing.
This is a visible behavior change on the starter, included in this slice because
`starterModelPolicyInputs()` is already being modified for completion-triggered
application.

The no-silent-substitution invariant is preserved throughout. Case 5 pre-selects
a visible default rather than persisting an unchosen one, and nothing is written
until a tuple is complete.

Coalescing introduces a window where the draft is ahead of the server. The panel
reports saving state during that window, and a rejected apply surfaces its reason
without reverting the draft, so the user can correct rather than lose the edit.

## Testing

Pure draft and completion logic in `sessionModelPolicyDraft.test.ts`: each
resolution-chain case seeds the expected draft; `sessionModelPolicyUpdateFromDraft`
returns `undefined` for every incomplete tuple, including a starter with empty
selections and Exact mode with a cleared thinking level.

Control behavior in `SessionModelPolicyControl.test.ts`: a tier click applies
immediately; an Exact model change alone does not apply; an Exact model change
followed by a supported level applies once; rapid level changes coalesce to a
single apply; a model change that preserves the level applies on one
interaction.

Starter wiring in `PiWebUiApp.sessionModelPolicy.test.ts`: case 4 renders the
control with empty selections and a blocked start; an empty `models` array
produces the models-not-configured reason; a failed catalog with a valid
confirmed tuple keeps send enabled.

Blocking is asserted against its three causes, with an explicit negative test
that a failed catalog fetch alone does not block send.
