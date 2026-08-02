# Composer model policy cascading controls

## Problem

The session model policy is edited in a 360px popover containing four `<select>`
fields (Mode, Tier, Exact model, Thinking level) plus Save and Cancel. Three
problems follow from that shape.

It duplicates controls the composer already has. `PromptEditor` renders a model
button and a thinking button that open pickers through `onSelectModel` and
`onSelectThinking`. In Exact mode the panel's own model and thinking selects
restate those two controls, so the same choice exists twice in one row.

A `<select>` is the wrong control for the model list. `openModelDialog()` reads
every model from `listModels()` across all providers; a native dropdown of that
list is unusable, which is why the composer's own model button already opens a
searchable modal instead.

The panel is a deferred form in a place that otherwise applies immediately, so a
selection needs a second confirming click.

This design removes the panel and expresses the policy as three cascading
controls in the composer action row.

## Approach

Mode becomes a two-item anchored menu on the existing pill. The second control is
mode-dependent: a tier menu in Tiered mode, the existing searchable model picker
in Exact mode. The third control, thinking level, exists only in Exact mode and
becomes a small anchored menu.

The panel, its four selects, and Save/Cancel are deleted. The pure modules from
the prior slice (`isDraftReadyToApply`, `seedModelPolicyDraft`) are retained
unchanged and keep deciding when a tuple is complete.

Two alternatives were rejected. *Keeping the panel and only restyling it* leaves
the duplicated controls and the unusable model select. *Making everything a
modal picker* is wrong for Mode and Thinking, where two and five short options
respectively do not warrant a modal with a search field.

## Mechanism

### Control layout

| Mode | First control | Second control | Third control |
| --- | --- | --- | --- |
| Exact | `Exact ▾` pill → mode menu | model button → searchable picker | thinking button → level menu |
| Tiered | `Tiered ▾` pill → mode menu | tier button → tier menu | absent |

The thinking control is **absent** in Tiered mode, not disabled: the ladder
determines both halves of the tuple, so a thinking control there would imply an
editable choice that does not exist. The action row therefore changes width
between modes, which is accepted.

### Mode menu

Exactly two items, `Exact model` and `Tiered`, each with a short hint and a
checkmark on the current mode. No other content.

### Tier menu

Six fixed rows from `MODEL_TIERS`, each showing what it resolves to from the
loaded catalog. A row whose `catalog.rows[tier].valid` is false renders dimmed and
unselectable with its `reason` inline, so a misconfiguration stays visible and
diagnosable rather than hidden. Selecting a valid tier applies immediately,
because one tier value resolves a complete model and thinking pair.

### Model picker

Reuses `command-picker` exactly as `openModelDialog()` already builds it:
`searchable={true}`, sorted by provider then id, current entry marked. No change
to that component.

### Thinking menu

An anchored menu listing the levels **the selected model supports**, sorted
ascending in the canonical order `off, low, medium, high, xhigh`, each with its
`thinkingDescription()` cost hint. Levels the model does not support are shown
dimmed and unselectable with `unsupported by this model` rather than omitted, so
the reason a level is unavailable is visible.

This is new behavior. The existing thinking dialog has no notion of the selected
model, lists whatever `listThinkingLevels()` returns, and does not sort.

### Application timing

Unchanged in substance from the prior slice, now spanning separate controls.

A tier selection applies immediately. An Exact selection applies once the model
and a supported thinking level are both set, coalesced behind a short trailing
delay. `sessionModelPolicyUpdateFromDraft` remains the single gate: an apply
fires only when it returns a defined update.

Selecting a model whose supported levels exclude the current level clears that
level, leaving the tuple incomplete. Nothing is sent until a supported level is
chosen. Applying the incomplete pair would fail server validation and can leave a
`MODEL_POLICY_BLOCKED` runtime block that survives reload and close/reopen, so a
routine model change would break the session.

Because the two Exact controls are now separate surfaces, the pending coalesced
apply must survive one menu closing before the other opens. It is cancelled only
on an actual mode change or on component disconnect.

### Mode switching is non-destructive

Switching mode never rewrites the other mode's remembered selection. An Exact
pair survives a round trip through Tiered and back unchanged, and a remembered
tier survives a round trip through Exact. Mode changes route through
`selectDraftExact` and `selectDraftTier` so mode and tuple stay in one draft
object.

### Write path

This is the load-bearing change. `pickModel` and `pickThinking` currently call
`sessions.setModel(...)` and `sessions.setThinkingLevel(...)`, which reach
`api.setModel` and `api.setThinkingLevel` directly and bypass the policy layer.

When the session supports `sessions.modelPolicy`, an Exact selection must instead
go through `setModelPolicy` so the tuple is applied atomically and persisted as a
policy entry. When the capability is absent, the legacy direct writes remain.

Four call sites branch on that capability: the active-session model and thinking
handlers, and their two starter variants. A selection that took the legacy path on
a policy-capable session would persist a model the policy layer does not know
about, which is the split-brain this feature exists to prevent.

### Diagnostics

Deleting the panel removes where `blockedReason`, `configError`, and per-tier
reasons render. They are preserved as follows.

Per-tier reasons move inline into the tier menu rows, as above.

Session-level blocked state keeps the **existing diagnostic chip**, which already
renders as a sibling of the trigger rather than inside the panel and therefore
survives the deletion unchanged: truncated text beside the pill with the full
reason in `title`. This matters because a `MODEL_POLICY_BLOCKED` runtime block is
not tied to any tier row; it is session state that clears only through a
successful explicit application.

A catalog that failed to load does not block sending. The session's confirmed
tuple is unchanged and unambiguous, and the catalog is what a repair would need,
so blocking would strand the user with no reachable recovery. The affected control
reports that its options are unavailable and offers a retry.

## Consequences

The panel component's rendering, its four selects, and Save/Cancel are deleted,
along with the panel-shaped tests that pin them. `isDraftReadyToApply` and
`seedModelPolicyDraft` are retained and reused.

An unconfigured machine shows both dependent controls as unset with a blocked
start reason, instead of rendering no policy control at all.

Filtering thinking levels by the selected model is a behavior change to a control
shared with non-policy sessions. It applies only on the policy path; the legacy
dialog is unchanged.

## Testing

Pure logic keeps its existing coverage. Both retained modules already have
mutation-verified tests and need no change.

Control rendering: the mode menu contains exactly two items; the second control
lists tiers in Tiered and opens the searchable picker in Exact; the thinking
control is absent in Tiered.

Thinking menu: levels appear in canonical ascending order; unsupported levels
render dimmed and unselectable; each supported level carries its cost hint.

Application timing: a tier selection applies immediately; an Exact model change
alone does not apply; a model change followed by a supported level applies once;
rapid level changes coalesce to one apply; a pending apply survives a menu close
and is cancelled on a mode change.

Mode round trips: Exact pair preserved through Tiered and back; remembered tier
preserved through Exact and back.

Write path: a policy-capable session routes an Exact selection through
`setModelPolicy`, and a session without the capability still uses the legacy
writes. Asserted for both the active and starter call sites.

Diagnostics: a blocked session renders the chip with its reason while the panel no
longer exists; an invalid tier row is unselectable with its reason; a failed
catalog leaves sending enabled.
