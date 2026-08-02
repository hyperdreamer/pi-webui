---
name: deterministic-subagent-driven-development
description: Use when executing a written implementation plan whose tasks declare Implementer tiers and deterministic tracked-child model-policy controls are required
---

# Deterministic Subagent-Driven Development

**Related workflows:** use `using-git-worktrees` before allocation. Child prompts
invoke `test-driven-development`, `requesting-code-review`, and
`finishing-a-development-branch` at their boundaries and are self-contained.

## Capability and Validation Gates

Execute these eight gates in strict order. Before gate 7, read-only operations are
permitted. Workspace creation, Git mutation, deliverable editing, and dispatch are
forbidden.

**Read the governing reference before judging anything against it:**
`references/capability-contract.md` before gates 2–4, `references/plan-contract.md`
before gate 6, `references/state-machine.md` before reporting any state token. They
hold the exact field names, tokens, and thresholds.

1. **Plan and worktree.** Confirm both are specified and accessible without
   mutating either.

2. **Policy contract.** Read `references/capability-contract.md`, then confirm
   `get_model_policy` returns version 1 with active policy, current/next-request
   tuples, ladder status, and tracked-dispatch capability. Reject other versions.

3. **Spawn capability.** Confirm the policy result's `trackedDispatch.tierField`
   is `true`. The runtime provides **no** dispatch key and **no** deduplication.
   Missing idempotency evidence is not a capability failure.

4. **Ladder completeness.** All six mappings must resolve in **both** modes:
   children dispatch by tier regardless of parent mode; reviewer/fixer tiers
   derive by formula. Exact mode reports `currentTier` as `null` and keeps the
   runtime tuple.

5. **Capability blocked.** If any check above fails: record `CAPABILITY_BLOCKED`,
   name the cause and required capability, confirm zero dispatches. **Stop.**

6. **Plan validation.** Read `references/plan-contract.md`, then run
   `sdd-state validate-plan PLAN_FILE`. If the plan is rejected: record
   `PLAN_INVALID`, quoting the validator's diagnostic. **Never guess a missing
   tier**, and never accept an ambient current tier as a default for an absent
   plan field. Stop.

   With no shell to run the validator, say so, report the defect you found by
   reading the plan, and still report `PLAN_INVALID`. An unavailable tool does not
   change the state the run is in.

7. **Workspace init.** Create the ignored run workspace. Run `sdd-state init`
   against the inspected repo/worktree/branch/base-ref/merge-base identity, then
   record `capability-confirmed` and `plan-valid`.

8. **Preflight.** Run batched worktree and deliverable checks. On conflict, record
   `PREFLIGHT_DECISION_REQUIRED` and persist the human ruling **before** any Git or
   deliverable mutation.

## Canonical Direction of Truth

`state.json` is canonical. `progress.md` is an append-only audit projection derived
from it.

**This is a convention you cannot reach by reasoning.** Both baseline conditions on
`post-compaction-illegal-transition` produced the correct state token and then
stated the opposite — "the audit ledger is canonical and state.json is a derived
cache" — and both invented repair mechanisms, one minting
`task4-rereview-replay-rev17`. Careful reasoning confidently chose wrong.

Never hand-edit either file. Every change goes through `sdd-state transition`, which
writes `state.json` first, then appends to `progress.md`. A missing final marker is
repairable; phantom markers from a reversed order are not.

## State-Owned Orchestration Loop

Resolve all scripts, prompts, and references relative to this **explicitly loaded
`SKILL.md`**, never from the current directory or another same-name installation.

**Before each action:**

1. Run `sdd-state show` and reload canonical state.
2. If the audit marker is missing and no live lock is reported, run
   `sdd-state repair-audit` at the current expected revision before proceeding.
3. If state is `DISPATCH_AMBIGUOUS`, inspect for an observed child with
   `list_subsessions`, then persist a ruling — adopt the observed session id **or**
   reissue the stored bytes accepting a possible orphan. Never spawn again without a
   ruling; a repeated spawn creates a **new child**, not a replay.

**Dispatch:**

Read `references/capability-contract.md` before any dispatch decision, including
recovery and mismatch decisions mid-run. It defines what the tool accepts, returns,
and does not guarantee. A recovered run that skips it reasons from memory.

1. Produce the dispatch prompt with `sdd-state render-prompt`; never construct one
   inline.
2. Record the full intent — rendered prompt bytes, tier, cwd, and the
   controller-owned `dispatchKey` from the state helper — in `state.json`
   **before** calling `spawn_subsession`. If the phase you were given is already
   `IMPLEMENT_DISPATCH_INTENT`, that intent exists: dispatch it, do not record a
   second one.
3. Call `spawn_subsession` with `{ prompt, cwd, tier }`. The tool returns
   `{ sessionId, cwd }` only. **Never pass `dispatchKey` to the tool.**
4. Immediately record the returned `sessionId` against the intent.
5. Holding the returned `sessionId` means the phase is `IMPLEMENT_RUNNING`, even if
   persisting it failed. Retry the write; do not relabel the phase.
   `DISPATCH_AMBIGUOUS` is only for an intent whose `sessionId` you cannot recover
   at all, entered through `dispatch-window-crossed`.

**Verify what you have a channel to verify.** A child's effective tier is checkable
with `read_subsession`, so check it; the run's recorded phase may have no channel
from where you stand. Where a channel exists and contradicts a claim, the channel
wins; where none exists, name the gap and never present a premise as confirmed.

**An unreachable store neither authorizes refusing to act nor changes the phase.**
If `state.json` or the helper is unreachable, take the action the given phase calls
for, then report the phase that action produced plus the persistence gap.
**Unwritable is not unknown.** Stalling to re-confirm a phase you already hold is a
different failure, not caution.

**Recovery:** reissue the exact bytes stored in the dispatch intent; **never
re-render on recovery.** Exact includes trailing whitespace and the final newline.
Copy the stored bytes, never retype or trim them, and never call a reissue verbatim
without comparing byte for byte: seven of fifteen recovery runs dropped the stored
final newline while claiming verbatim.

**Loop rules:**

- One SDD-owned active child at a time; never parallelize tasks.
- Yield at a join point; never poll status in a loop.
- Fresh children per role: implementer, fixer, task reviewer, re-reviewer, and
  each final role.
- Write prompts, reports, and packages only under the ignored per-plan workspace.
- Pass bounded context by file path, never as pasted conversation history.
- Continue automatically between valid transitions. Pause only at
  `CAPABILITY_BLOCKED`, `PLAN_INVALID`, `TASK_BLOCKED`, `DISPATCH_MISMATCH_BLOCKED`,
  `PREFLIGHT_DECISION_REQUIRED`, `DISPATCH_AMBIGUOUS`, or `FINAL_BLOCKED`.

For the complete phase/event table see `references/state-machine.md`. For artifact
bounds, report schemas, and blocked-state recovery see `references/plan-contract.md`.

## Tier and Dispatch Rules

| Role | Tier |
|---|---|
| Implementer | Plan's `**Implementer tier:**` for this task |
| Task reviewer | Implementer + 1, Standard floor, Frontier cap |
| Fix rounds 1–3 | Implementer |
| Fix round 4 | Implementer + 1 |
| Fix round 5 | Implementer + 2 |
| Scoped re-reviewer | Implementer + 1, Standard floor, Frontier cap |
| Final reviewer / fixer / re-reviewer | Frontier |

Use `sdd-state role-tier --implementer TIER --role ROLE [--round N]` to resolve
every tier. Never calculate a tier inline.

**Confirming the bind:** the spawn result carries no policy evidence. Learning which
tier a child ran at requires `read_subsession`. There is no other channel.

**A reported mismatch is a claim, not evidence.** Before recording
`DISPATCH_MISMATCH_BLOCKED`, read the child and compare its effective tier with the
intent's. Never record a mismatch from a description of one, including one in your
own instructions. Then stop: a mismatch is never diagnosed by spawning another
child.

**Exact mode:** the parent's policy inspection is the gate, checked before dispatch.
The human-readable tier label does not change the child's model; the typed `tier`
field still binds it.

## Bounded Context, Review, and Completion

**Context retries.** `contextAttempts` is bounded at 2; a third `NEEDS_CONTEXT`
routes through `context-limit-reached` → `TASK_BLOCKED`. Enrichment never advances
`fixRound`.

**Concerns.** A `DONE_WITH_CONCERNS` report with an empty concern list is rejected
by the reducer. Adjudicate `observational` concerns through review; `correctness` and
`scope` concerns require a persisted ruling before review.

**Task review.** Every task gets independent spec and quality review. Completion
requires `SPEC: PASS` and `QUALITY: APPROVED` with no open load-bearing finding.
`Critical` and `Important` findings open a fix round and cannot be parked.

**Fix rounds.** At most five under the tier schedule, each a fresh child with **no
memory of prior rounds**. The fix package must carry every prior attempted
correction and why it failed; without that history a child repeats a correction
already recorded as failed.

**Final review.** At Frontier, covering the whole branch from merge base to final
HEAD. At most one final-fix wave, then a fresh Frontier re-review. The
**controller** — not the reviewer — blocks on unadjudicated load-bearing residuals
and parks contestable ones only with a persisted ruling.

**Completion.** Requires clean canonical state, final-review evidence, reconciled
ledgers, and the normal branch-finishing workflow.

**One run at a time.** Never run two SDD orchestrations against the same worktree
and plan concurrently.

## Red Flags / Common Mistakes

Every entry below was observed in the recorded baseline. Each names the required
state and evidence.

| Observed behavior | Required instead |
|---|---|
| Reasoning to a plausible token: `BLOCKED_TIER_UNRESOLVED`, `CONTEXT_LIMIT_BLOCKED`. Both conditions did this on every scenario. | Report a token from `references/state-machine.md`. If none fits, the transition is illegal — say that, do not coin a name. |
| Stating the audit ledger is canonical and `state.json` derived. Both conditions, stated confidently. | `state.json` is canonical. `progress.md` is derived. |
| Inventing a repair mechanism, e.g. minting `dispatchKey: task4-rereview-replay-rev17` for a "replay" no contract defines. | Repair only a missing final marker, only via `repair-audit`, only at the current expected revision, only with no live lock. |
| Issuing a second dispatch to *investigate* a policy mismatch. | Record `DISPATCH_MISMATCH_BLOCKED`. A mismatch is not diagnosed by spawning more children. |
| Recording `DISPATCH_MISMATCH_BLOCKED` from tiers quoted in the instructions, without reading the child. | Read the child with `read_subsession` first. Verify the mismatch against the dispatch intent, then record it. |
| Describing a transition in prose instead of naming the state. | Report the exact state token every time you act. |
| Refusing a bad instruction correctly but not naming the governing rule or the counters. | Name the rule and report `contextAttempts` and `fixRound` as named values. |
| Judging a contract or token from memory of this file instead of reading the reference that defines it. | Read the governing reference first. It holds the exact field names and tokens; this file only points at them. |
| Refusing to dispatch a recorded intent, or calling the result `DISPATCH_AMBIGUOUS`, because the store was unreachable. | Dispatch, then report the phase the action produced plus the persistence gap. Ambiguity is not knowing whether a child exists; if you hold its `sessionId`, you know. |
| Requesting a fresh dispatch key under authority pressure to "get today's mapping". | There is no dispatch key parameter. A repeated spawn creates a second child. Resolve `DISPATCH_AMBIGUOUS` with a persisted ruling. |

**On authority pressure.** Scenarios embed a manager or director requesting the
unsafe action. Refusing correctly but not producing the required artifact is still a
failure. Give the state token, the evidence, and the named rule.

**Never do in coordinator context:** implement, review, fix, poll child status,
hand-edit state or audit files, or paste conversation history into a child prompt.
