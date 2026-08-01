# Plan and Artifact Contract

What a plan must contain for the deterministic controller to run it, and what each
artifact may hold. The grammar here is **copied from** `scripts/lib/plan-policy.mjs`
and never widened; that module is the authority. Transitions live in
[`state-machine.md`](state-machine.md) and are not restated here.

## Contents

- [Plan grammar](#plan-grammar)
- [Tiers and role formulas](#tiers-and-role-formulas)
- [Identity pinning](#identity-pinning)
- [Preflight](#preflight)
- [Report schemas](#report-schemas)
- [The fix package](#the-fix-package)
- [Artifact separation](#artifact-separation)
- [Bounds](#bounds)
- [Blocked-state recovery](#blocked-state-recovery)

## Plan grammar

A task heading is exactly:

```text
## Task <N>: <Title>
```

`<N>` starts at 1 and increases by 1 with no gaps. Any other task-like ATX heading
outside a code fence is an error, including `### Task 1:`. This matters in practice
because the `writing-plans` skill currently emits `### Task N:` with no tier field,
so a plan from that skill must be converted before this controller will accept it.
`validate-plan` names the depth found, the depth required, and the repair.

Each task carries exactly one tier field, outside any code fence:

```text
**Implementer tier:** Advanced
```

Title case in the plan document, lowercase on the wire. The parser normalizes at
that boundary so no dispatch site has to remember to.

An optional `## Global Constraints` section precedes the first task and appears at
most once. When present it is included in **every** task brief, because a child
that never sees the plan cannot infer a constraint stated only there.

Fence handling follows the parser exactly: fenced content is inert, so a fenced
`## Task 1:` example is not a task. Indented four-space blocks are ordinary
content.

**A tier-annotated plan is a precondition, not an inference.** A plan missing a
tier enters `PLAN_INVALID` with a diagnostic naming the repair. The controller
never guesses a tier: guessing is precisely what the typed `tier` parameter exists
to eliminate.

## Tiers and role formulas

Six tiers, ascending: `economy`, `fast`, `standard`, `advanced`, `capable`,
`frontier`.

| Role | Tier |
| --- | --- |
| Implementer | the plan's `**Implementer tier:**` for that task |
| Task reviewer | implementer + 1, floored at `standard`, capped at `frontier` |
| Re-reviewer | same formula as the task reviewer |
| Fixer | implementer, + 1 rung at fix round 4, + 2 rungs at round 5 |
| Final reviewer, final fixer, final re-reviewer | always `frontier` |

The escalation map is `{1:0, 2:0, 3:0, 4:1, 5:2}`. A consequence worth stating:
at round 5 the fixer can sit one rung **above** the re-reviewer, because the
re-reviewer formula takes no round. That is pinned in tests as a deliberate
decision; changing it requires changing this contract.

`tier` is the binding channel. The rendered prompt also opens with
`/tier-<lowercase>` as a human-readable echo. The echo carries no control effect —
the runtime never parses prompt text to select a model — but PI WEBUI does reject
a leading directive that *disagrees* with the typed tier, so the echo works as a
cross-check. An absent echo is not an error; a disagreeing one is.

## Identity pinning

At init the run pins: the plan's SHA-256 digest, repo root, worktree, run root,
branch, base ref, and merge base. Then

```text
runId = sha256(planDigest ⁰ worktree ⁰ branch ⁰ mergeBase ⁰ createdAt)
dispatchKey = <runId>:task-<n>:<role>:attempt-<n>[:round-<n>]
```

(`⁰` is a NUL byte; no component may contain one.)

`dispatchKey` is **controller-owned**. It is never passed to `spawn_subsession`,
which accepts only `{ prompt, cwd, tier }` and returns `{ sessionId, cwd }`. The
key names a row in this run's own ledger so recovery can correlate an intent to
the session the tool returned. It buys correlation, not idempotency.

Every mutation recomputes the plan digest. Drift fails closed with exit 4: a plan
edited mid-run invalidates every tier already dispatched, so the run stops for a
human decision rather than continuing against a plan nobody reviewed.

**Ground truth for "was this work done" is Git commits and artifacts on disk**,
not session identity. This is inherited from the original SDD skill, and it is why
a lost correlation degrades to reading `git log` and report files rather than to an
unrecoverable run.

## Preflight

The run wants a fresh worktree at a known merge base. If the tree is dirty or the
branch has unexpected commits, preflight reports a conflict and the run enters
`PREFLIGHT_DECISION_REQUIRED`. Leaving it needs a persisted ruling naming a
decision and a reason. Untracked build output is usually fine to proceed past;
uncommitted source changes usually are not. The controller does not decide that
silently.

## Report schemas

Every child writes exactly one bounded report at the report path it was given, and
returns exactly one status.

**Implementer and fixer:**

```text
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED

CHANGES:
- <file>: <what changed and why>

TESTS:
- <command>: <result, with counts>

CONCERNS:            (required when DONE_WITH_CONCERNS; the reducer rejects an
                      empty list, so a hedged status must name something)
- kind: observational | correctness | scope
  note: <one line>

COMMIT: <sha>        (when the role commits)
```

`observational` concerns pass to review. A `correctness` or `scope` concern routes
to `CONCERN_DECISION_REQUIRED` and needs a ruling, because those two are findings
wearing a softer word.

`NEEDS_CONTEXT` must name what is missing and why it is load-bearing. Two
enrichments are allowed at the planned tier; a third blocks. Enrichment is not a
fix round and never touches `fixRound`.

**Task reviewer and re-reviewer:**

```text
SPEC: PASS | FAIL
QUALITY: APPROVED | CHANGES_REQUESTED
FINDINGS:
- id: F-<n>
  severity: Critical | Important | Minor
  loadBearing: yes | no
  location: <file>:<line>
  evidence: <what was observed, not what was assumed>
  impact: <consequence>
  correction: <what would resolve it>
```

Both axes are required and independent. Task completion needs `PASS` **and**
`APPROVED` with no open load-bearing finding.

`Critical` and `Important` are load-bearing: they open a fix round and can never be
parked. `Minor` is contestable and may be parked with a ruling that names evidence.
Severity is fixed when first reported and cannot be re-reported lower, which closes
the obvious route to dismissing a finding.

A re-reviewer returns one verdict per open finding — `RESOLVED`, `STILL_PRESENT`,
`REGRESSION`, or `NEEDS_CONTEXT` — scoped to that fix's Git range. It may report a
regression the fix introduced. It may not expand into a fresh whole-task review.

## The fix package

Every fix round dispatches a **fresh child with no memory of prior rounds**. The
package must therefore carry:

1. the task brief, including Global Constraints;
2. the persistent implementer report;
3. the exact open findings, by ID, with evidence;
4. **each prior attempted correction and why it failed**;
5. the relevant tests;
6. the scoped diff for the range under repair.

Item 4 is the one that is easy to omit and expensive to omit. Without it, round 3
can re-apply the fix that failed in round 2, spend a full review cycle, and arrive
back at the same finding. The child must read that history and must not repeat a
correction already recorded as failed.

## Artifact separation

| Artifact | Location | Writer |
| --- | --- | --- |
| Deliverables | the worktree | implementer, fixer |
| Reports | run root | each child, one file each |
| Task briefs | run root | `task-brief` |
| Review packages | run root | `review-package` |
| Rendered prompts | run root | `render-prompt` |
| `state.json` | run root | the store, under lock |
| `progress.md` | run root | the store, append-only |

`state.json` is canonical; `progress.md` is derived. Never hand-edit either. A
hand-edited state is indistinguishable from a corrupted one, and the reducer is
built to refuse exactly the plausible-looking repair a stuck controller would
otherwise invent.

## Bounds

Each tested at the limit and one byte past it.

| Thing | Bound |
| --- | --- |
| Task brief | 256 KiB |
| Rendered prompt | 384 KiB |
| Child or reviewer report | 64 KiB |
| `state.json` | 1 MiB |
| One audit line | 8 KiB |
| Finding records | 256 |
| Any single path | 4096 UTF-8 bytes |
| Any recorded human string | 256 characters, single line |

Recorded strings reject control characters and the audit marker outright rather
than escaping them, so no reason text can forge a transition record.

## Blocked-state recovery

| State | What it means | What clears it |
| --- | --- | --- |
| `CAPABILITY_BLOCKED` | tier resolution or the policy tool is unavailable | fix the environment; re-init |
| `PLAN_INVALID` | grammar, tier, or digest failure | repair the plan; re-init, since the digest changed |
| `PREFLIGHT_DECISION_REQUIRED` | the tree is not in the expected shape | a persisted preflight ruling |
| `DISPATCH_AMBIGUOUS` | the spawn/correlate window was crossed | a ruling: adopt an observed session, or reissue stored bytes |
| `DISPATCH_MISMATCH_BLOCKED` | a dispatch did not match its intent | human inspection; no automatic path |
| `TASK_BLOCKED` / `FINAL_BLOCKED` | terminal | a human decision outside the run |

`DISPATCH_AMBIGUOUS` deserves emphasis: the runtime offers no dispatch
idempotency, so a crash between the spawn call and the ledger write can orphan a
child. That window cannot be closed from the controller. The guarantee is that it
is always **visible** and never silently resolved.
