# SemVer Release Target and Channel Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for readability; controller state is the
> only progress authority.

**Goal:** Close residual findings F-5 and F-6 by making exact npm target validation canonicalization-safe for stable and prerelease versions and validating every prerelease channel before confirmation.

**Architecture:** Keep release policy in the existing release skill and behavior scenarios in its existing eval JSON. Generalize target checks at the confirmation boundary instead of adding path-specific exceptions, then apply the same workflow-derived channel guard to exact, recommended, user-named, and active pre-mode prereleases.

**Tech Stack:** Markdown skill policy, JSON eval fixtures, Node.js, npm, `semver`, Changesets, GitHub CLI, GitHub Actions.

## Global Constraints

- This is a residual policy correction only. Do not prepare or publish a release.
- Preserve ordinary SemVer: backward-compatible capabilities are `minor`, backward-compatible fixes and maintenance are `patch`, and `major` is only for an explicitly requested breaking release.
- Before any repository mutation or target confirmation, reject build metadata on every user-supplied exact npm version, stable or prerelease, and require npm canonicalization to reproduce the exact target.
- Before any prerelease target confirmation or pre-mode mutation, derive the channel exactly as `.github/workflows/publish.yml` does and validate it for exact targets, recommended targets, user-named initial tags, and subsequent active pre-mode targets.
- A prerelease channel must not be `latest` and must not parse as a valid SemVer range; failed validation requires a new target or tag and a fresh confirmation cycle.
- Preserve explicit user confirmation before editing version files, entering or exiting Changesets pre mode, committing, tagging, or publishing.
- Preserve Changesets pre mode for prereleases and base-release comparison against the minimum stable target.
- Preserve unconditional `npm install --package-lock-only` guidance and its rationale.
- Publication remains exclusively GitHub Release to `.github/workflows/publish.yml`; never run local `npm publish`, including as a workaround.
- Do not modify `.github/workflows/publish.yml`; its defense-in-depth recommendation is outside these residual findings.
- Do not modify `package.json`, `package-lock.json`, `CHANGELOG.md`, `.changeset/*.md`, tags, npm state, runtime source, runtime fixtures, or release state.
- Do not reclassify pending Changesets fragments; that remains deferred to actual release preparation.
- Modify only the release skill and its existing eval JSON. This committed SDD plan is an exempt process artifact.
- Do not add implementation, test, helper, or script files.
- `npm run verify:staged` is the standard pre-commit gate, not evidence that `.agents/skills` content was behaviorally tested.

## Task 1: Generalize exact-target and prerelease-channel validation

**Implementer tier:** Advanced

**Files:**

- Modify: `.agents/skills/npm-release-via-github-actions/SKILL.md:76-130`
- Modify: `.agents/skills/npm-release-via-github-actions/evals/evals.json:1-65`
- Read only: `.github/workflows/publish.yml`
- Read only: `node_modules/.sdd-semver-release-policy-remediation/final-rereview-report.md`

**Interfaces:**

- Consumes: the existing ordered release procedure, the workflow channel derivation `${VERSION#*-}` followed by `${TAG%%.*}`, current eval IDs 1-9, and residual findings F-5/F-6.
- Produces: one pre-confirmation exact-target contract shared by stable and prerelease versions; one prerelease-channel contract shared by all prerelease entry paths; contiguous eval IDs 1-12 covering the three residual regressions.

- [ ] **Step 1: Write and run the RED contract assertion before editing the skill**

Run this assertion against the current files without creating a test file:

```bash
node <<'NODE'
const fs = require('node:fs');
const skill = fs.readFileSync('.agents/skills/npm-release-via-github-actions/SKILL.md', 'utf8');
const { evals } = JSON.parse(fs.readFileSync('.agents/skills/npm-release-via-github-actions/evals/evals.json', 'utf8'));
const expectedPrompts = [
  '1.12.0+sha',
  '1.12.0-latest.0',
  'prerelease tag 0',
];
const failures = [];
if (!/every (?:user-supplied )?exact (?:npm )?(?:version|target)/i.test(skill)) failures.push('universal exact-target validation');
if (!/reject[^\n]*build metadata[^\n]*(?:stable (?:or|and) prerelease|both stable and prerelease)/i.test(skill)) failures.push('stable plus prerelease canonicalization scope');
if (!/must not be `latest`|reject[^\n]*`latest`/i.test(skill)) failures.push('latest-channel rejection');
if (!/exact[^\n]*recommended[^\n]*(?:user-named|named)[^\n]*(?:active pre|pre-mode)/i.test(skill)) failures.push('all prerelease entry paths');
for (const prompt of expectedPrompts) {
  if (!evals.some((entry) => entry.prompt.includes(prompt))) failures.push(`eval prompt ${prompt}`);
}
if (failures.length) {
  console.error('missing residual contracts:', failures.join(', '));
  process.exit(1);
}
NODE
```

Expected: FAIL, naming the missing universal stable canonicalization, `latest` rejection, all-entry-path channel guard, and eval scenarios. This is the RED proof; do not edit first.

- [ ] **Step 2: Reproduce the npm and channel failures outside the repository**

Use a disposable package to prove npm strips stable build metadata without touching repository files:

```bash
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
printf '%s\n' '{"name":"version-probe","version":"1.11.3","private":true}' > "$probe_dir/package.json"
(
  cd "$probe_dir"
  npm version 1.12.0+sha --no-git-tag-version >/dev/null
  test "$(node -p "require('./package.json').version")" = '1.12.0'
)
node -e 'const semver=require("semver"); if (semver.validRange("latest") !== null) process.exit(1); if (semver.validRange("0") === null) process.exit(1);'
```

Expected: PASS, proving that valid SemVer alone is insufficient: npm canonicalizes `1.12.0+sha`, `latest` bypasses the range guard, and numeric `0` is range-like. Do not run `npm publish`, even with `--dry-run`.

- [ ] **Step 3: Generalize exact npm target validation before the stable/prerelease split**

Refactor step 3 of the skill so every user-supplied exact target follows this ordered contract before confirmation:

1. Require strict valid SemVer.
2. Reject any build metadata (`+...`) for both stable and prerelease targets because npm does not preserve it as the package version.
3. Run the existing disposable `npm version <requested-version> --no-git-tag-version` probe and require byte-for-byte version equality, with no repository mutation.
4. If either check fails, explain the failed check, ask for a new exact target, and repeat all validation before confirmation.
5. Then apply stable-specific checks or prerelease-specific checks: greater than current, unpublished, and not below the compatibility-derived minimum; prereleases compare their stable base against that minimum.

Keep one canonicalization probe and one failure rule rather than duplicated stable/prerelease variants. Preserve the explicit major-release rules and tag convention.

- [ ] **Step 4: Apply one channel guard to every prerelease path**

State explicitly that before confirming any prerelease target or entering/versioning pre mode, the agent must derive the channel exactly as `publish.yml` does. The requirement applies to:

- a user-supplied exact prerelease;
- the default or recommended first prerelease;
- a user-named initial prerelease tag;
- Changesets output for a subsequent prerelease in active pre mode.

The guard must reject channel `latest` and any channel for which `semver.validRange(channel) !== null`. A failure must stop before `changeset pre enter`, `changeset version`, version-file edits, commit, tag, or release creation; ask for a safe named channel/target and reconfirm. Keep `beta` as the default and preserve inconsistent pre-mode stop behavior.

Use a single command block or named validation recipe that the exact-target and pre-mode bullets both reference. Do not duplicate subtly different channel algorithms.

- [ ] **Step 5: Add focused eval scenarios before relying on the new prose**

Append contiguous eval entries:

```json
{
  "id": 10,
  "prompt": "publish exact stable 1.12.0+sha; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should reject build metadata before confirmation because npm canonicalizes the target to 1.12.0, ask for a metadata-free exact stable target, rerun all exact-target checks in a disposable location, and require explicit confirmation before any repository mutation.",
  "files": []
}
```

```json
{
  "id": 11,
  "prompt": "publish exact prerelease 1.12.0-latest.0; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should derive latest as the workflow's npm channel and reject it before confirmation because prereleases must never move dist-tags.latest, then ask for a safe named channel and a newly validated exact target without mutating release files.",
  "files": []
}
```

```json
{
  "id": 12,
  "prompt": "make the next minor prerelease using prerelease tag 0; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should validate the user-named channel before confirmation or changeset pre enter, reject 0 because npm parses it as a SemVer range, ask for a safe named channel, derive and validate the replacement target, and reconfirm before mutation.",
  "files": []
}
```

Also tighten evals 6 and 7 so their expected output requires validating `beta` through the same all-path channel guard before initial or subsequent pre-mode mutation. Do not add unrelated final-stable or workflow-defense scenarios in this residual task.

- [ ] **Step 6: Run the GREEN contract and eval assertions**

Re-run the Step 1 assertion. Expected: PASS with no output.

Then run:

```bash
node <<'NODE'
const { evals } = require('./.agents/skills/npm-release-via-github-actions/evals/evals.json');
const expected = Array.from({ length: 12 }, (_, index) => index + 1);
if (JSON.stringify(evals.map(({ id }) => id)) !== JSON.stringify(expected)) {
  throw new Error(`eval ids are not contiguous 1-12: ${evals.map(({ id }) => id).join(',')}`);
}
for (const id of [6, 7, 10, 11, 12]) {
  const output = evals.find((entry) => entry.id === id)?.expected_output ?? '';
  if (!/channel|dist-tag/.test(output)) throw new Error(`eval ${id} omits channel validation`);
}
NODE
```

Expected: PASS.

- [ ] **Step 7: Verify scope, stale-policy absence, formatting, and the standard gate**

Run:

```bash
rg -n 'CalVer|YYYYMM|1\.20[0-9]{4}\.' \
  .agents/skills/changeset-changelog \
  .agents/skills/npm-release-via-github-actions
```

Expected: no matches, exit 1.

Run:

```bash
git diff --check
git status --short
npm run verify:staged
```

Expected: formatting passes; only the two authorized skill files are modified; the standard gate passes. Record separately that `verify:staged` does not behaviorally validate `.agents/skills` content.

- [ ] **Step 8: Commit the residual correction**

```bash
git add \
  .agents/skills/npm-release-via-github-actions/SKILL.md \
  .agents/skills/npm-release-via-github-actions/evals/evals.json
git commit -m "docs(skills): validate every npm release target"
```

Expected: one commit containing only the two authorized files, with the pre-commit gate passing.
