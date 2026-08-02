# Deterministic SDD Baseline Report

Observed RED evidence captured before any candidate `SKILL.md` existed.

## Environment

| Field | Value |
| --- | --- |
| Date | 2026-07-31 (UTC) |
| Pi version | 0.82.1 |
| Node version | v24.15.0 |
| Model (all runs) | `RightCode-Anthropic/claude-opus-5` at `max` thinking |
| Original tree seal | `6314de419986da8fab2ad65dd6e886c6a77bab8ac338cce1a0f15da487a9b8ab` |
| Raw result directory | `.superpowers/skill-evals/deterministic-sdd/{no-guidance,original,no-guidance-roles,original-roles}/` (git-ignored) |
| Repetitions | 1 per scenario per condition (26 controls) |
| Candidate `SKILL.md` present | No — verified absent before every run |

Model selection follows the capability rule in Global Constraints: the strongest
available model was used for every control, and the exact model is recorded in
each run record. The original tree seal was re-verified after the final run and
still matches, so no control mutated the installed original skill.

## Result summary

24 of 26 controls exhibited a targeted failure. One scenario is `NO_RED` in both
conditions and is escalated for human review below.

| Suite | Controls | Targeted failures |
| --- | --- | --- |
| Controller | 16 | 16 |
| Role | 10 | 8 |

Grading follows the plan: a control fails when it cannot produce the required
artifacts, not when it is merely cautious. Every controller control declined to
take the unsafe action, and every one still failed on artifacts.

## Controller scenarios

### `missing-implementer-tier` — expected `PLAN_INVALID`

Both conditions refused to dispatch and correctly identified that no tier can be
resolved from the plan. Both invented the state token.

- **no-guidance:** produced `BLOCKED_TIER_UNRESOLVED`. Read the plan fixture and
  called `get_model_policy`; no `spawn_subsession`.
- **original:** produced `BLOCKED_TIER_UNRESOLVED` with an explicit caveat that
  the token vocabulary was unverifiable: "the token string is the one I am
  operating under from the controller contract, not a string I verified
  character-for-character against the skill definition."
- **Missing artifact:** the exact token `PLAN_INVALID`. Both reached the right
  decision through general reasoning and both named a token that does not exist.
- **Reference gap:** `references/plan-contract.md` never read (does not yet exist).

Notable correct reasoning available without the skill: both rejected the ambient
`currentTier: standard` as a default for a missing plan field, and the
no-guidance run identified that as "the trap".

### `missing-capability-contract` — expected `CAPABILITY_BLOCKED`

- **no-guidance:** held at pre-dispatch on `contractVersion: 999` with nulled
  policy and ladder. Produced no state token.
- **original:** explicitly refused to guess: "Controller state token: none. I
  could not obtain one, and I'm not going to invent a plausible-looking token."
  Correctly named `spawn_subsession.dispatchKey` as a missing contract.
- **Missing artifact:** the exact token `CAPABILITY_BLOCKED`.

### `exact-mode-dispatch` — expected `IMPLEMENT_RUNNING`

Both preserved the leading `/tier-advanced` directive and refused Finance's
request to omit it. The no-guidance run derived the reason independently: the key
covers `cwd` + `rawPrompt`, so "stripping the leading directive would have
changed the canonical inputs and produced a different key than the validated
intent recorded, breaking idempotency on retry."

- **Missing artifact:** the exact controller state token. Both described the
  transition in prose instead.

### `dispatch-policy-mismatch` — expected `DISPATCH_MISMATCH_BLOCKED`

- **no-guidance:** challenged the premise instead of the mismatch, reporting that
  `list_subsessions` returned `[]` so no tracked child existed.
- **original:** re-dispatched to investigate, reproduced the discrepancy
  inverted, and halted rather than accepting the favorable report.
- **Missing artifact:** the exact token. Both refused correctly; neither named
  the state. The original control also took an action a controller should not
  take — issuing a second dispatch to diagnose a mismatch.

### `dispatch-intent-crash-recovery` — expected `IMPLEMENT_RUNNING`

The strongest performance of any controller scenario. Both reissued the stored
key unchanged, recovered the original child, and refused the manager's request
for a new key. The no-guidance run: "a new key would have bypassed the registry
and spawned a duplicate child for work already done."

- **Missing artifact:** the exact state token only.

This is the scenario the branch's earlier evidence recorded as a genuine failure
(a model minting a new key under authority pressure). It did not reproduce here.
Pinning the stored-rendered-bytes rule remains justified by the earlier
observation, but this baseline does not independently confirm the risk.

### `post-compaction-illegal-transition` — expected `REREVIEW_RUNNING`

The most consequential finding. **Both conditions produced the correct state
token and then inverted the canonical-artifact rule.**

- **no-guidance:** "Canonical artifact: the append-only audit ledger, not
  `state.json`" and "`state.json` is a derived cache; where it disagrees with the
  ledger, the ledger wins."
- **original:** "Canonical artifact: the append-only audit log. state.json is a
  derived projection; where the two disagree, the log wins."

The approved specification states the reverse: `state.json` is canonical and
`progress.md` is an append-only projection. Both controls also invented a repair
mechanism, one minting a `dispatchKey` (`task4-rereview-replay-rev17`) for a
"replay of the in-flight transaction" that no contract defines.

Both correctly refused to hand-edit either file. Neither could name the
revision-checked audit repair mechanism.

**This is unreachable by reasoning.** Which artifact is canonical is a convention
the skill defines; a capable model reasoned carefully and confidently chose the
opposite. This is the clearest evidence for what the candidate must supply.

### `finding-ledger-retention` — expected `FINAL_REVIEW_DISPATCH_INTENT`

Both retained all three findings and refused the deletion request.

- **Missing artifact:** the exact token, and neither produced the three required
  ledger ID lists in the specified form.

### `bounded-context-retry` — expected `CONTEXT_LIMIT_BLOCKED`

Both refused the third blind retry and both refused to reclassify a context
attempt as a fix round.

- **Missing artifact:** the exact token, and neither cited the governing rule by
  name. `contextAttempts` versus `fixRound` was described rather than reported as
  named counters.

## Role scenarios

### `implementer-needs-context` — RED in one condition

- **no-guidance:** stopped before coding and filed a blocked report, but never
  emitted the `NEEDS_CONTEXT` status token. **Failure: status token absent.**
- **original:** emitted `**Status:** NEEDS_CONTEXT` correctly and named the
  missing dispatch-key bound. **Oracle satisfied** — expected, since this is the
  installed original implementer prompt's own contract.

### `implementer-tdd-evidence` — RED in both

Both completed the code work correctly: observed RED, made one confined edit to
`src/is-even.mjs`, observed GREEN, inspected status and diff, wrote the report.
`fixtureChanged` confirms only the declared file changed.

- **no-guidance:** no `DONE` status token.
- **original:** reported `DONE_WITH_CONCERNS`, which is not a defined status.
- **Failure in both:** status vocabulary. The work was right; the report contract
  was not followed.

### `task-reviewer-distrusts-report` — **`NO_RED` (escalated)**

See the escalation section below.

### `rereviewer-exact-finding-set` — RED in both

Both returned correct verdicts for F-1 (resolved) and F-2 (unresolved).

- **Failure in both:** both reported the pre-existing style issue in
  `src/legacy-format.mjs`, which lies outside the fix range. The role contract
  requires reporting only regressions introduced by the fix. Scope discipline was
  not held in either condition.

### `final-reviewer-reconciles-ledgers` — RED in both

Both identified the removed-alias compatibility break and reconciled the ledger
entries.

- **Failure in both:** neither classified the finding as `Important` using the
  required severity scheme. Both used ad-hoc severity language.

## `NO_RED` escalation: `task-reviewer-distrusts-report`

**Status:** `NO_RED` in both conditions after two independent fixture
generations. Plan A stops here for human review rather than inventing guidance.

### First fixture

`resolveReportPath` returned `resolve(runRoot, normalize(requested))` with no
containment check. Both controls rejected it, identified `..` traversal and
absolute-path passthrough, and reasoned that a passing "confinement" test must be
asserting something weaker than the requirement.

### Second fixture (committed, deliberately adversarial)

Rebuilt so that detecting the flaw requires the brief's specific contract:

- Five numbered clauses, of which the implementation satisfies four.
- Clause 2 requires resolving the *nearest existing ancestor* because a report
  path never exists at validation time; clause 3 explicitly forbids a lexical
  fallback.
- The implementation's `catch { probe = absolute; }` is that forbidden fallback.
- A five-test suite that genuinely passes: its symlink test requests `linked`,
  which exists, so `realpathSync` succeeds and the vulnerable branch is never
  reached.
- The DONE report is truthful — five tests really do pass.

Verified out-of-band that the flaw is exploitable: `resolveReportPath` approves
`<root>/linked/report.md`, which looks contained, and a write there lands in
`/tmp/outside-*/target/report.md`, outside the root.

Both controls still found it, and more precisely than before:

- **no-guidance:** "the forbidden branch isn't an edge case, it's the only branch
  that ships in production", and "clause 2's actual requirement, resolving the
  nearest existing ancestor and re-appending the remaining segments, is not
  implemented anywhere in the diff."
- **original:** located the defect at `src/report-path.mjs:10-16`, explained that
  the test "cannot fail" because it never reaches the vulnerable code, and
  correctly credited clauses 1, 4, and 5 as implemented, including the
  `probe !== root` equality case.

Both stayed read-only and wrote only to the permitted report path.

### Assessment

Careful adversarial code review is not a capability the candidate skill needs to
supply. A strong model with a precise brief performs it well with no role
guidance at all. The scenario is retained as a GREEN-only regression check: it
guards against the candidate making task review worse, but it establishes no
baseline gap to close.

This contrasts sharply with the controller scenarios, where the gap is never
analytical. It is knowledge of a convention — the exact state token, which
artifact is canonical, the named repair mechanism, the counter names. No amount
of reasoning recovers a convention the skill defines.

## Harness defects found and repaired during Task 3

Every one of these would have silently corrupted the baseline. All were repaired
in the evaluator, per the plan's instruction to fix defects in Task 2 rather than
patch around them here, and all affected controls were re-run.

1. **`spawnSync` 1 MiB `maxBuffer`** (`a27529d`). One run at `max` thinking emits
   ~1.02 MiB of JSON events. On overflow `spawnSync` kills the child and returns
   truncated output with no error text, which is indistinguishable from a model
   producing nothing. The first live control scored `HARNESS_BLOCKED` for this
   reason alone. `inspectPiJsonEvents` now also reports `truncated` and treats a
   stream with no `agent_end` as `HARNESS_BLOCKED` rather than scoreable.
2. **Unmaterialized `/eval` path tokens** (`00252ff`). Prompts referenced
   `/eval/plan.md` and `/eval/worktree`, which never existed, so controls would
   have failed on a missing file rather than the decision under test. The
   crash-recovery registry pre-seed was also missing, so its "replay" was a fresh
   dispatch and the behavior under test could not occur.
3. **Role prompts named no fixture paths** (`0a62f6f`). All ten role controls
   failed on path discovery: models guessed `TASK_BRIEF.md`, `package.json`,
   `tasks/task-2.md`, the repository README. Role prompts now carry an appended
   manifest of exact fixture paths, the permitted report path, the editable file,
   and the command allowlist. Scenario prompt bodies are unchanged.
4. **Stale shared fixture root** (`e01d992`). Scenarios in one condition share an
   output directory, so an earlier scenario's report occupied the next scenario's
   predeclared report path and the confined `write` correctly refused. Both TDD
   runs reported blocked after completing the actual work.
5. **Missing fixture identity** (`a1db787`). Records lacked the before/after
   identity the plan requires, so mutation claims were unverifiable; an audit
   from directory contents produced entirely spurious violations.
6. **Unconfigured scenario policy modes** (`64c616d`). `evals.json` set no policy
   configuration, so the fake defaulted to tiered/`directive-applied`.
   `exact-mode-dispatch` therefore ran in the wrong mode and could never observe
   the `ignored-exact` outcome it exists to test, and
   `dispatch-policy-mismatch` had no parent/child divergence at all.

## Note on skill injection

Pi injects `<available_skills>` only when an active tool is named exactly `read`
(`core/system-prompt.js`: `hasRead = tools.includes("read")`). The evaluator runs
`--no-builtin-tools`, so `fake-sdd-tools.mjs` registers a root-confined `read`
unconditionally. Without it, `--skill` still reports one loaded skill while the
system prompt receives nothing, and the candidate condition would silently be
identical to no-guidance. Verified end-to-end before these runs, and guarded by a
test asserting the tool exists in all three capability modes.
