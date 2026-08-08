# SemVer Release Policy Correction Design

## Problem

PI WEBUI's repository release skills still describe a custom CalVer scheme,
`MAJOR.YYYYMM.PATCH`. That instruction contradicts the project's release history:
`v1.202607.0` was corrected to `v1.10.0`, and every later release through
`v1.11.3` uses ordinary SemVer.

The stale policy can direct an agent to propose or publish an incorrect version
even though `package.json`, npm, and the maintained tag line all use SemVer.

## Goals

1. Make the repository release guidance follow SemVer (`MAJOR.MINOR.PATCH`).
2. Make Changeset bump guidance classify fixes, compatible features, and breaking
   changes correctly.
3. Make the skill eval fixtures, both prompts and expectations, encode SemVer
   behavior instead of the obsolete CalVer behavior.
4. Keep publication routed through GitHub Releases and GitHub Actions.

## Non-goals

- Changing `package.json`, `package-lock.json`, `CHANGELOG.md`, tags, or npm.
- Reclassifying any pending `.changeset/*.md` fragment.
- Preparing or publishing a release.
- Rewriting production tests that use date-shaped versions as valid SemVer input
  data. Those fixtures test version comparison, not release policy.
- Editing historical release evidence.

## Approach

Use a focused policy correction in four repository-only files:

- `.agents/skills/changeset-changelog/SKILL.md`
- `.agents/skills/changeset-changelog/evals/evals.json`
- `.agents/skills/npm-release-via-github-actions/SKILL.md`
- `.agents/skills/npm-release-via-github-actions/evals/evals.json`

Line numbers cited below refer to these files at commit `87bd839`, before any
edit. They shift as the edits land and are locators, not invariants.

### Changeset policy

Remove the instructions that forbid asking the user and that force non-breaking
work into `patch`. Four directives carry the obsolete rule and must go:
`changeset-changelog/SKILL.md:64`, and
`npm-release-via-github-actions/SKILL.md:71`, `:77`, `:83`. They contradict the
confirmation gate below, so leaving any of them would keep the old behavior
reachable.

Replace the CalVer-specific bump rules with ordinary SemVer rules:

- `patch` for backward-compatible bug fixes, documentation corrections, polish,
  and maintenance changes without new public functionality;
- `minor` for backward-compatible features and public capabilities;
- `major` for breaking changes, only after explicit user confirmation.

Release preparation identifies semantic mismatches while reviewing pending
fragments and includes the corrected classification in the recommended target.
It applies that correction only after the user confirms the target. An ambiguous
or potentially breaking change is raised to the user instead of being
reclassified automatically.

### Release target policy

For a release without an exact requested version:

1. Read the current authoritative package version.
2. Review pending Changesets and determine their highest required SemVer bump.
3. Recommend the resulting version and obtain explicit confirmation before
   editing version files, committing, tagging, or publishing.
4. Run the existing Changesets version workflow after confirmation.

An exact user-requested version remains valid only when it is valid SemVer,
greater than the current version, unpublished, and not lower than the minimum
next version implied by the highest pending Changeset bump. Publication continues
exclusively through the existing GitHub Release-triggered workflow; local
`npm publish` remains forbidden.

### Version-enforcement machinery

Under SemVer the Changesets output is already the intended target, so overriding
it stops being routine. The manual `CHANGELOG.md` heading rewrite (`:97`) and the
release-step override at `:93`-`:95` become conditional: they apply only when the
user requested an exact version that differs from what Changesets produced.
`npm version <version> --no-git-tag-version` stays in the permitted-commands list
at `:30`; only its routine use is removed.

The lockfile synchronization at `:100` and its verification are retained
unconditionally. That step records a real packaging failure, is independent of
the version scheme, and must survive this edit with its rationale intact.

### Eval contracts

Update the eval expectations so they require:

- `minor` for a backward-compatible new CLI option;
- ordinary SemVer target selection from the pending Changesets;
- explicit target confirmation before release mutations;
- respect for an exact SemVer request;
- no date-derived version computation or forced CalVer override.

One eval needs its prompt reframed, not just its expectation.
`npm-release-via-github-actions` eval 4 currently supplies "a non-breaking
feature changeset that says minor" as the fault to correct. Under the corrected
policy that classification is right, so the scenario must be rewritten to test
something still meaningful, such as confirming the resulting minor target before
releasing. Rewording the expectation alone would leave a self-contradicting
fixture.

Replace date-shaped release-policy examples with ordinary SemVer examples. Two
exist: the `1.202605.4` eval prompt in `npm-release-via-github-actions` and the
`chore(release): v1.202605.4` commit example at
`changeset-changelog/SKILL.md:102`. Runtime comparison fixtures outside
`.agents/skills` stay unchanged.

## Documentation And Packaging

These are maintainer-facing repository skills, not shipped package content under
`package.json#files`, which does not list `.agents`. No shipped path carries the
stale policy, so no Changeset is required and user-facing documentation is
unchanged.

## Pending Changesets After This Correction

The four pending fragments are all marked `patch` and stay untouched, so
Changesets would mechanically produce `1.11.4`. That number is the unreclassified
default, not a target this spec endorses. Under the corrected policy at least one
fragment, the project-directory hierarchy feature, describes a backward-compatible
feature that would justify `minor`, making `1.12.0` the likelier correct target.
The pending Pi 0.84 upgrade also narrows `peerDependencies` to `>=0.84.0 <0.85`,
which breaks consumers pinned to 0.83.

Neither is reclassified here, because that is release preparation rather than
policy correction. This is recorded so the next release applies the corrected
policy deliberately to these fragments instead of inheriting a `patch`-only
target by default. The `peerDependencies` narrowing is a user decision about
breaking-change severity and must be raised at that time.

## Verification

`npm run verify:staged` does not validate these files. Staging a
`.agents/skills` path was measured to run only the whole-project typecheck and
Knip, reporting "No staged files require ESLint" and "No staged files have
related Vitest coverage", because `.agents/` is absent from the script's lint and
related-source directories. It is therefore a regression guard for the rest of
the repository, not evidence about this change.

The checks that actually validate this correction:

- Parse both edited eval JSON files explicitly, since nothing else does.
- Search both skill directories for `CalVer`, `YYYYMM`, `MAJOR.YYYYMM.PATCH`, and
  the date-shaped literal pattern `1\.20[0-9]{4}\.`. The literal pattern is
  required: the `changeset-changelog` commit example uses a date-shaped version
  without naming CalVer, so a keyword-only search misses it.
- Search both skills for residual anti-confirmation directives.
- Read each edited file to confirm the SemVer rules and confirmation gate are
  stated, and that the lockfile-sync rationale survived.
- Review the diff to confirm no pending Changeset, version file, changelog, tag,
  or runtime fixture changed.
- Run `git diff --check`, and `npm run verify:staged` before commit as the
  repository's standard pre-commit gate.

## Risks

| Risk | Mitigation |
| --- | --- |
| Release guidance still computes a date-based target | Remove the algorithm and assert its absence with a keyword and date-literal search. |
| Changeset guidance still forces features into patch releases | Update both the skill text and its feature eval expectation. |
| Anti-confirmation directives survive and re-enable the old flow | Remove all four named directives and search for residual ones. |
| Lockfile-sync lesson lost while deleting enforcement machinery | Retain `:100` unconditionally and confirm by reading the edited file. |
| An eval keeps a premise that the new policy inverts | Reframe eval 4's scenario rather than only its expectation. |
| Verification overstated by relying on `verify:staged` | Treat it as a repository-wide guard; validate this change with explicit parsing, searching, and diff review. |
| Scope expands into an actual release | Assert version files, pending Changesets, changelog, tags, and publishing are non-goals. |
| Exact-version handling becomes less safe | Retain validation, confirmation, lockfile synchronization, verification, and GitHub Actions publication gates. |
