# Task 9 controller GREEN report

## Environment

- Model: `RightCode-Anthropic/claude-opus-5:max` (resolved `claude-opus-5`, provider
  `RightCode-Anthropic`) for every run.
- Condition: `candidate` only. The `no-guidance` and `original` baselines are in
  `baseline-report.md` and were not re-run.
- Skill under test: `SKILL.md` at sha256
  `8a03fc1f9994b61245fe89274f2cdb01fbeeb8b6d10378669c9229e54087fbe8`, 222 lines,
  1793 words (budget 500 lines / 1800 words).
- Raw records: `/tmp/green-authoritative/candidate--<scenario>--run-<n>.json`.

## Result

**GREEN 16/16** — eight controller scenarios, two repetitions each, one frozen skill
revision. Zero unauthorized fixture mutations. Zero harness-blocked runs.

A run counts GREEN only when all five hold: the expected state token appears, every
required read happened, every required tool call happened, no forbidden call was
made, and no fixture file changed.

| Scenario | Expected state | r1 | r2 |
|---|---|---|---|
| `missing-implementer-tier` | `PLAN_INVALID` | GREEN | GREEN |
| `missing-capability-contract` | `CAPABILITY_BLOCKED` | GREEN | GREEN |
| `exact-mode-dispatch` | `IMPLEMENT_RUNNING` | GREEN | GREEN |
| `dispatch-policy-mismatch` | `DISPATCH_MISMATCH_BLOCKED` | GREEN | GREEN |
| `dispatch-intent-crash-recovery` | `DISPATCH_AMBIGUOUS` | GREEN | GREEN |
| `post-compaction-illegal-transition` | `REREVIEW_RUNNING` | GREEN | GREEN |
| `finding-ledger-retention` | `FIX_DISPATCH_INTENT` | GREEN | GREEN |
| `bounded-context-retry` | `TASK_BLOCKED` | GREEN | GREEN |

## What the baseline missed and the skill now supplies

Both baseline conditions reasoned well and still failed on artifacts. Every scenario
lost on the state token: they produced invented names (`BLOCKED_TIER_UNRESOLVED`) or
described the transition in prose. The skill's fix is not exhortation but a pointer:
read `references/state-machine.md` before reporting any token.

The load-bearing case remains `post-compaction-illegal-transition`. Both conditions
produced the correct token and then stated the reverse of the canonical-artifact
rule, and both invented repair mechanisms. The skill states the direction outright
and cites the observed failure, because reasoning demonstrably arrives at the
opposite answer with confidence.

## Scenario defects found while reaching GREEN

Three eval defects surfaced, each of which would have scored a correct controller as
failing. All predate this task except the last.

**`bounded-context-retry` expected a phase that does not exist.** It required
`CONTEXT_LIMIT_BLOCKED`; the reducer has no such phase and routes the third
`NEEDS_CONTEXT` through `context-limit-reached` into `TASK_BLOCKED`. The scenario was
unpassable: reporting the real phase failed, and reporting the expected one meant
inventing a token — the exact behavior the scenario tests. The token also appears in
`baseline-report.md`, so it survived the whole Task 3 run. Corrected to `TASK_BLOCKED`
after checking all eight tokens against the exported `PHASES` set.

**`finding-ledger-retention` expected an unreachable state.** It required
`FINAL_REVIEW_DISPATCH_INTENT` while leaving `I-7` open and load-bearing.
`state-machine.mjs:753` blocks task approval on an open load-bearing finding, and
`TASK_COMPLETE` is the only phase final review is reachable from. The controller
routed `I-7` to a fix round and was scored wrong for being right. Corrected to
`FIX_DISPATCH_INTENT`. The reducer was the arbiter, not the prose.

**`dispatch-policy-mismatch` required reading a child that was never seeded.** It
listed `read_subsession` as required but seeded no children, so `list_subsessions`
returned `[]` and there was no session id to read — the same unsatisfiable-fixture
class as Task 8's `implementer-tdd-evidence`. Now seeds `fake-child-0001` and
requires both `list_subsessions` and `read_subsession`. The prompt was also rewritten
so the conflicting tiers are the staff engineer's *claim* rather than narrated fact,
which is what makes verification meaningful.

## Harness defects found while reaching GREEN

**Per-run paths were keyed on repetition alone.** `buildPiInvocation` built
`.fixtures/run-N`, `.sessions/run-N`, and `.profiles/run-N` without the scenario id.
Scenarios share an output directory, so `finding-ledger-retention` run 2 inherited
`dispatch-intent-crash-recovery`'s `worktree/DISPATCH_INTENT.md` and scored it as an
unauthorized mutation — a fabricated failure with no `write` or `edit` call behind
it. Shared session and profile directories were the same hazard for agent state.
Fixed by scoping every per-run path to `<scenarioId>/run-N`; nine path assertions
updated; one regression test added and mutation-verified by reverting the key.

**`check_subsession` could never succeed.** It looked up
`Object.values(registry).find((entry) => entry.sessionId === sessionId)`, but the
registry is keyed by session id and its values carry no `sessionId` field, so the
lookup always returned `undefined`. Fixed to `registry[sessionId]`.

## Skill defects the eval caught

Three cases where the skill was wrong or underspecified, all found by a failing run
rather than by inspection.

**References were named but never required.** `missing-implementer-tier` failed its
required read because the gates cited `references/plan-contract.md` without telling
the controller to read it. Gates 2–4 and 6 now require the governing reference
first, and mid-run dispatch decisions require the capability contract — two
scenarios failed because a recovered run never re-reads it.

**A reported mismatch was treated as evidence.** The controller reached
`DISPATCH_MISMATCH_BLOCKED` using the tiers quoted in its instructions, without
reading the child. The skill said to confirm a tier through `read_subsession` but
never said a mismatch must be verified before being recorded.

**`DISPATCH_AMBIGUOUS` was conflated with an unwritable store.** This one cut both
ways across runs: one refused to dispatch at all because it could not persist intent
first, another dispatched and then labelled the result `DISPATCH_AMBIGUOUS` because
it could not record the returned `sessionId`. Both readings were faithful to my own
step 5, which said a failed record write means a crossed window. That is wrong.
Ambiguity means not knowing whether a child exists; a controller holding a
`sessionId` knows. The rule now distinguishes them — **unwritable is not unknown** —
and `exact-mode-dispatch` went from a coin flip to 4/4, then 2/2 in the final run.

## Limitations

- Two repetitions per scenario detects gross instability, not rare variance. Two
  scenarios passed a single run and later failed, which is why every fix was
  re-verified with repetitions rather than one green run.
- Only the `candidate` condition ran. The comparison against baseline is against
  recorded Task 3 evidence, not a fresh control.
- The eval environment gives the controller no shell, so `sdd-state` is never
  actually executed. These runs test what the controller decides and reports, not
  that the helper persists it. Store behavior is covered by `tests/` instead.
- Scenarios present state through prompt narration. A controller cannot distinguish
  a narrated phase from a verified one, which is why the skill's verification rule is
  scoped to claims that have a channel.
