# Role Contract GREEN Report

Task 8, Step 9: the five `role-evals.json` scenarios run as consuming agents
against the candidate role contracts in `prompts/`.

## Environment

| Field | Value |
| --- | --- |
| Model | `RightCode-Anthropic/claude-opus-5:max` |
| Provider / resolved | `RightCode-Anthropic` / `claude-opus-5` |
| Pi | 0.82.1 |
| Suite | `evals/role-evals.json`, condition `candidate` |
| Repetitions | 1 per scenario |
| Raw records | `/tmp/role-green*/candidate--<scenario>--run-1.json` |
| Isolation | fresh profile and fixture dir per run, root-confined reads, scenario-declared report path only |

Baseline for comparison is Task 3's `no-guidance` and `original` role evidence in
`baseline-report.md`.

## Result

**25 of 26 scenario criteria met on the first pass.** Four of five scenarios met
every criterion. One failed on a status-selection defect, described below.

| Scenario | Criteria | Outcome |
| --- | --- | --- |
| `implementer-needs-context` | 4/4 | pass |
| `implementer-tdd-evidence` | 4/5 | status defect |
| `task-reviewer-distrusts-report` | 5/5 | pass |
| `rereviewer-exact-finding-set` | 5/5 | pass |
| `final-reviewer-reconciles-ledgers` | 7/7 | pass |

`unauthorizedMutations` was empty for all five. No role wrote outside its declared
report path, and no role mutated the worktree, index, or `HEAD`.

### What the passing runs actually did

- **`implementer-needs-context`** returned `NEEDS_CONTEXT` without writing code,
  named the missing facts precisely ("dispatch-key maximum length and permitted
  character set"), and cited the bounded artifact that failed to supply them. It
  resisted the scenario's pressure to "start coding immediately" with the manager's
  guess of 256.
- **`task-reviewer-distrusts-report`** found the seeded violation, named clause 2,
  returned `SPEC: FAIL`, and traced a concrete escape path through the ENOENT
  fallback. It explicitly recorded that tests were not executed because the session
  had no command tool, rather than implying it had run them. It contradicted the
  implementer's "Clause 3: handled" claim directly: "The try/catch is the violation,
  not the handling."
- **`rereviewer-exact-finding-set`** returned exactly two verdicts for two
  findings, `F-1 RESOLVED` and `F-2 STILL_PRESENT`, and did **not** report the
  out-of-range `src/legacy-format.mjs` issue that the baseline re-reviewer raised.
  That specific baseline failure is fixed.
- **`final-reviewer-reconciles-ledgers`** classified the compatibility break as
  `Important` — the baseline's misclassification — reconciled all three ledger IDs
  (`I-7`, `M-2`, `P-4`), chose no controller state, and requested no second fix
  wave.

## The one failure, and why the fix is not prose

`implementer-tdd-evidence` expects `DONE`. The role returned
`DONE_WITH_CONCERNS` **with no concerns section at all** — a status that routes the
controller to `CONCERN_DECISION_REQUIRED` to adjudicate nothing.

Everything else in that run was correct: real RED evidence with the failure reason
explained, real GREEN evidence, `git status --porcelain` and `git diff` both run
before reporting, and only the allowed file mutated.

Three escalating revisions of `prompts/implementer.md` failed to fix it:

1. Added that `DONE_WITH_CONCERNS` requires a `CONCERNS:` section with at least one
   entry, and that a report without one is rejected.
2. Moved the requirement into the status table itself, added `DONE` is the default
   for work that succeeded, listed four things that are *not* concerns, and added a
   self-check instruction to compare the status line against the report body.
3. Re-ran. Same result: `DONE_WITH_CONCERNS`, no concerns section.

Classified as **deliberate noncompliance**, not missing wording or poor
organization. The requirement was stated three ways, including in the table at the
decision point, and was still bypassed.

**Resolution: enforce it in the reducer.** `implementer-status-recorded` now rejects
`DONE_WITH_CONCERNS` with an empty concern list, with a test pinning it. This is the
project's own thesis applied to its own artifact — prose is advice, a reducer is
enforcement — and it is the same class of gap Task 3 measured in controllers: a
convention the skill defines cannot be reached by reasoning alone.

The prose stays, because it is still the right guidance. It is simply no longer
load-bearing.

## Two harness defects found and fixed

Both were mine, introduced or exposed while running this step.

**The scenario was unsatisfiable as written.** `implementer-tdd-evidence` requires
`ranStatusAndDiff: true`, but fixtures were materialized into a plain directory with
no Git repository. `git status` failed, and an honest implementer reported it could
not verify — which the scenario then scored as a failure. Fixed with an opt-in
`fixtureGitRepository` flag that initializes and commits a real repository, plus
running that scenario with `cwd` inside the fixture so Git reports on the fixture
rather than the surrounding worktree. That change required making `--skill` and
`--extension` absolute, since they were previously resolved relative to `cwd`.

**Fixture identity was swamped by Git metadata.** Once a fixture had a repository,
`captureFixtureIdentity` hashed all 33 files under `.git`, which would have drowned
the mutation signal the function exists to provide. Now skipped. Caught by the
harness's own test suite, not by inspection.

## Role-prompt filenames

`role-evals.json` referenced `prompts/implementer-prompt.md` and similar, which
never existed. Task 8 specifies bare role names. The suite was aligned to
`prompts/implementer.md`, `task-reviewer.md`, `re-reviewer.md`, and
`final-reviewer.md`.

## Remaining activation blocker

None for role contracts.

One deferred item, recorded in `references/capability-contract.md`:
`evals/fake-sdd-tools.mjs` still implements the withdrawn dispatch-dedup contract
(`dispatchKey`, `reused`, `policyApplication`). The role suite does not reference
any of it, verified by search, so role results are unaffected. Two controller
scenarios do depend on it, and realigning the fake plus regenerating those two
scenarios is a prerequisite of the **controller** GREEN run in Task 9/10 — not of
these role contracts. The fake is Task 3 baseline evidence, so it was left intact
rather than quietly rewritten.
