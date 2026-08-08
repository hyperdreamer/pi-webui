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
3. Make the skill eval expectations reject the obsolete CalVer behavior.
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

### Changeset policy

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

### Eval contracts

Update the eval expectations so they require:

- `minor` for a backward-compatible new CLI option;
- ordinary SemVer target selection from the pending Changesets;
- explicit target confirmation before release mutations;
- respect for an exact SemVer request;
- no date-derived version computation or forced CalVer override.

Replace date-shaped release-policy examples in the evals with ordinary SemVer
examples. Runtime comparison fixtures outside `.agents/skills` stay unchanged.

## Documentation And Packaging

These are maintainer-facing repository skills, not shipped package content under
`package.json#files`. No Changeset is required, and user-facing documentation is
unchanged.

## Verification

- Parse both edited eval JSON files.
- Search the two skill directories for `CalVer`, `YYYYMM`, and the obsolete
  `MAJOR.YYYYMM.PATCH` policy.
- Review the diff to confirm no pending Changeset or version metadata changed.
- Run `git diff --check`.
- Stage only the four policy files and run `npm run verify:staged`; unstage them
  after verification if implementation is not yet ready to commit.

## Risks

| Risk | Mitigation |
| --- | --- |
| Release guidance still computes a date-based target | Remove the algorithm and assert its absence with a focused search. |
| Changeset guidance still forces features into patch releases | Update both the skill text and its feature eval expectation. |
| Scope expands into an actual release | Assert version files, pending Changesets, changelog, tags, and publishing are non-goals. |
| Exact-version handling becomes less safe | Retain validation, confirmation, lockfile synchronization, verification, and GitHub Actions publication gates. |
