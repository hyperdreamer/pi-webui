# SDD State Machine Reference

The reducer in `scripts/lib/state-machine.mjs` is the authority. This document
describes it; it never redefines it. `TRANSITIONS` and `PHASES` are exported and
the test suite asserts this table against them, so drift fails a test rather than
misleading a reader.

## Contents

- [Two rules that shape everything](#two-rules-that-shape-everything)
- [Canonical direction of truth](#canonical-direction-of-truth)
- [Phases](#phases)
- [Transitions](#transitions)
- [Counters and their bounds](#counters-and-their-bounds)
- [The finding ledger](#the-finding-ledger)
- [Dispatch identity and the ambiguity window](#dispatch-identity-and-the-ambiguity-window)
- [Recovery authority](#recovery-authority)

## Two rules that shape everything

**Recording a result and deciding what it means are separate transitions.** A
`*-finished` event only pins a bounded artifact and a verdict. A separate,
explicit controller event selects the next phase. A child's report can never
choose the phase it leads to.

**Nothing is inferred from absence.** Every branch a human would call a judgement
call requires a persisted ruling naming a decision and a reason. The reducer never
picks the agreeable option by default.

Both rules come from measured failure, not taste. In the recorded baseline, both
conditions on `post-compaction-illegal-transition` produced the correct phase
token and then inverted the canonical-artifact rule and invented repair
mechanisms. One minted a fabricated dispatch key.

## Canonical direction of truth

`state.json` is canonical. The progress ledger is an append-only audit trail
**derived from it**. This direction is not negotiable.

Authority for whether work actually happened is Git commits and artifacts on
disk, inherited from the original SDD skill: trust the ledger and `git log` over
your own recollection. A lost correlation between a dispatch and a session
degrades to inspecting commits and reports, never to an unrecoverable run.

## Phases

30 phases. Six are terminal and accept no continuation event.

| Group | Phases |
| --- | --- |
| Gates | `CAPABILITY_CHECK`, `PLAN_VALIDATE`, `PREFLIGHT_DECISION_REQUIRED`, `WORKSPACE_READY` |
| Task loop | `IMPLEMENT_DISPATCH_INTENT`, `IMPLEMENT_RUNNING`, `IMPLEMENT_RESULT`, `CONTEXT_REQUIRED`, `CONCERN_DECISION_REQUIRED` |
| Review loop | `TASK_REVIEW_DISPATCH_INTENT`, `TASK_REVIEW_RUNNING`, `TASK_REVIEW_DECISION` |
| Fix loop | `FIX_DISPATCH_INTENT`, `FIX_RUNNING`, `REREVIEW_DISPATCH_INTENT`, `REREVIEW_RUNNING`, `TASK_COMPLETE` |
| Final loop | `FINAL_REVIEW_DISPATCH_INTENT`, `FINAL_REVIEW_RUNNING`, `FINAL_FIX_DISPATCH_INTENT`, `FINAL_FIX_RUNNING`, `FINAL_REREVIEW_DISPATCH_INTENT`, `FINAL_REREVIEW_RUNNING` |
| Ambiguity | `DISPATCH_AMBIGUOUS` |
| Terminal | `CAPABILITY_BLOCKED`, `PLAN_INVALID`, `TASK_BLOCKED`, `DISPATCH_MISMATCH_BLOCKED`, `FINAL_BLOCKED`, `COMPLETE` |

## Transitions

61 registered `(phase, event)` pairs. Any pair absent from this table is an
illegal transition.

| Source | Event | Destination |
| --- | --- | --- |
| any nonterminal | `recovery-ruling-recorded` | same phase; requires reason and receipt |
| `CAPABILITY_CHECK` | `capability-confirmed` | `PLAN_VALIDATE` |
| `CAPABILITY_CHECK` | `capability-missing` | `CAPABILITY_BLOCKED` |
| `PLAN_VALIDATE` | `plan-valid` | `PLAN_VALIDATE`, validation pinned |
| `PLAN_VALIDATE` | `plan-invalid` / `plan-conflict` | `PLAN_INVALID` |
| `PLAN_VALIDATE` | `preflight-clean` | `WORKSPACE_READY` |
| `PLAN_VALIDATE` | `preflight-conflict` | `PREFLIGHT_DECISION_REQUIRED` |
| `PREFLIGHT_DECISION_REQUIRED` | `preflight-approved` | `WORKSPACE_READY` |
| `PREFLIGHT_DECISION_REQUIRED` | `preflight-rejected` | `FINAL_BLOCKED` |
| `WORKSPACE_READY` | `implement-dispatch-intended` | `IMPLEMENT_DISPATCH_INTENT` |
| any `*_DISPATCH_INTENT` | `dispatch-started` | matching `*_RUNNING` |
| any `*_DISPATCH_INTENT` | `dispatch-mismatch` | `DISPATCH_MISMATCH_BLOCKED` |
| any `*_DISPATCH_INTENT` | `dispatch-window-crossed` | `DISPATCH_AMBIGUOUS` |
| `DISPATCH_AMBIGUOUS` | `dispatch-ruling-recorded` | the recorded intent's running phase (adopt) or intent phase (reissue) |
| `IMPLEMENT_RUNNING` | `implementer-finished` | `IMPLEMENT_RESULT` |
| `IMPLEMENT_RESULT` | `implementer-status-recorded` | status-pinned `IMPLEMENT_RESULT`, `CONTEXT_REQUIRED`, `CONCERN_DECISION_REQUIRED`, or `TASK_BLOCKED` |
| status-pinned `IMPLEMENT_RESULT` | `task-review-dispatch-intended` | `TASK_REVIEW_DISPATCH_INTENT` |
| `CONTEXT_REQUIRED` | `context-dispatch-intended` | `IMPLEMENT_DISPATCH_INTENT` |
| `CONTEXT_REQUIRED` | `context-limit-reached` | `TASK_BLOCKED` |
| `CONCERN_DECISION_REQUIRED` | `concern-ruling-recorded` | status-pinned `IMPLEMENT_RESULT` or `TASK_BLOCKED` |
| `TASK_REVIEW_RUNNING` | `task-review-finished` | `TASK_REVIEW_DECISION` |
| `TASK_REVIEW_DECISION` | `review-approved` | `TASK_COMPLETE` |
| `TASK_REVIEW_DECISION` | `fix-dispatch-intended` | `FIX_DISPATCH_INTENT` |
| `TASK_REVIEW_DECISION` | `review-blocked` | `TASK_BLOCKED` |
| `FIX_RUNNING` | `rereview-dispatch-intended` | `REREVIEW_DISPATCH_INTENT` |
| `FIX_RUNNING` | `fixer-blocked` | `TASK_BLOCKED` |
| `REREVIEW_RUNNING` | `rereview-finished` | result-pinned `REREVIEW_RUNNING` |
| result-pinned `REREVIEW_RUNNING` | `rereview-approved` | `TASK_COMPLETE` |
| result-pinned `REREVIEW_RUNNING` | `task-park-ruling-recorded` | result-pinned `REREVIEW_RUNNING` |
| result-pinned `REREVIEW_RUNNING` | `next-fix-dispatch-intended` | `FIX_DISPATCH_INTENT` |
| result-pinned `REREVIEW_RUNNING` | `rereview-blocked` | `TASK_BLOCKED` |
| `TASK_COMPLETE` | `next-task-ready` | `WORKSPACE_READY` at the next task |
| `TASK_COMPLETE` | `final-review-dispatch-intended` | `FINAL_REVIEW_DISPATCH_INTENT` |
| `FINAL_REVIEW_RUNNING` | `final-review-finished` | result-pinned `FINAL_REVIEW_RUNNING` |
| result-pinned `FINAL_REVIEW_RUNNING` | `final-complete` | `COMPLETE` |
| result-pinned `FINAL_REVIEW_RUNNING` | `final-fix-dispatch-intended` | `FINAL_FIX_DISPATCH_INTENT` |
| result-pinned `FINAL_REVIEW_RUNNING` | `final-blocked` | `FINAL_BLOCKED` |
| `FINAL_FIX_RUNNING` | `final-rereview-dispatch-intended` | `FINAL_REREVIEW_DISPATCH_INTENT` |
| `FINAL_FIX_RUNNING` | `final-fixer-blocked` | `FINAL_BLOCKED` |
| `FINAL_REREVIEW_RUNNING` | `final-rereview-finished` | result-pinned `FINAL_REREVIEW_RUNNING` |
| result-pinned `FINAL_REREVIEW_RUNNING` | `final-complete` | `COMPLETE` |
| result-pinned `FINAL_REREVIEW_RUNNING` | `final-park-ruling-recorded` | result-pinned `FINAL_REREVIEW_RUNNING` |
| result-pinned `FINAL_REREVIEW_RUNNING` | `final-blocked` | `FINAL_BLOCKED` |

Every `*-dispatch-intended` event carries a full dispatch intent and enters its
named intent phase **before** any spawn. Task completion requires spec `PASS` and
quality `APPROVED` together, with no open load-bearing finding.

## Counters and their bounds

| Field | Bound | Notes |
| --- | --- | --- |
| `contextAttempts` | 0–2 | A third `NEEDS_CONTEXT` must block. Never touches `fixRound`. |
| `fixRound` | 0–5 | The fixer tier escalates one rung at round 4 and two at round 5. A load-bearing residual at round 5 blocks. |
| `finalFixUsed` | one wave | A second final-fix wave is not legal. |
| `revision` | +1 per transition | Exactly one increment, including recovery rulings. |
| `recoveryRulings` | unbounded | Counted so interventions are visible in the audit trail. |

`currentImplementerTier` is derived **only** from the immutable task index
captured at initialization, never from a live re-parse.

## The finding ledger

Findings are keyed by immutable ID. Severity is recorded at report time and can
never be re-reported at a different level, so a finding cannot be downgraded on
its way to being dismissed.

`Critical` and `Important` are load-bearing: they open a fix round and can never
be parked. `Minor` is contestable and may be parked with a persisted ruling that
names evidence.

Reporting is additive and may grow the ledger. Adjudication is a set operation
that may change dispositions but can neither add nor remove entries, which is the
retention guarantee: no event can silently drop an open, deferred, or parked
finding. Every disposition requires evidence.

## Dispatch identity and the ambiguity window

`dispatchKey` is controller-owned, composed as
`<runId>:task-<n>:<role>:attempt-<n>[:round-<n>]`. It is **never** passed to
`spawn_subsession`, which accepts only `{ prompt, cwd, tier }` and returns
`{ sessionId, cwd }`.

The runtime provides no deduplication, so the key buys **correlation, not
idempotency**. A crash between the spawn call and the correlation write can orphan
a child. That window cannot be closed from here; it can only be made visible.
`DISPATCH_AMBIGUOUS` does exactly that, and leaving it requires an explicit
ruling: `adopt` names an observed session id, `reissue` sends the stored prompt
bytes and accepts a possible orphan. The reducer never picks.

An intent stores the exact rendered prompt bytes, bounded at 384 KiB, before any
session exists. Recovery reissues those bytes verbatim and never re-renders,
because re-rendering couples recovery to renderer output.

The typed `tier` selects the model. A leading `Model tier: <tier>` line is a
human-readable echo with no control effect: absent is fine, and disagreement with
the typed tier is reported as renderer/formula divergence.

## Recovery authority

`recovery-ruling-recorded` is legal in any nonterminal phase, never changes the
phase, and requires both a reason and a receipt. It exists so an intervention
appears in the audit trail instead of hiding.

Terminal phases accept no continuation event. Recovery from a terminal phase is a
human decision made outside the run.

**Never hand-edit `state.json` or the progress ledger.** Every change goes through
a transition so the revision, audit line, and validation all advance together. A
hand-edited state is indistinguishable from a corrupted one, and the reducer is
built to refuse exactly the kind of plausible-looking repair a stuck controller
would otherwise invent.
