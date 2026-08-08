# SemVer Exact Prerelease Flow and Channel Transport Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for readability; controller state is the
> only progress authority.

**Goal:** Close residual findings F-8 and F-9 by separating the sole confirmed release target from Changesets intermediate candidates and making prerelease tags safe before entering pre mode.

**Architecture:** Model release preparation as explicit generated-target and exact-target flows. Every package-version candidate is validated, but only the selected release target is presented for confirmation; a differing Changesets candidate is an internal intermediate that may be overridden after versioning. Reject option-like channels before command execution and verify the durable pre-mode state immediately after `pre enter`.

**Tech Stack:** Markdown skill policy, JSON eval fixtures, Node.js, npm, `semver`, Changesets, GitHub CLI, GitHub Actions.

## Global Constraints

- This is a residual policy correction only. Do not prepare or publish a release.
- Preserve ordinary SemVer compatibility classification and explicit confirmation before release mutation.
- A release flow has exactly one release target presented for confirmation. A differing Changesets-generated version is an intermediate candidate, not a second target, and must never receive a second confirmation.
- Validate every release target and every Changesets intermediate candidate with the existing strict-SemVer, build-metadata, and disposable npm byte-equality contract before mutation.
- Generated-target flows confirm the validated Changesets candidate once. Exact-target flows retain the validated user-supplied exact target as the sole confirmed target and use the existing post-version override when Changesets emits a different valid intermediate.
- Initial and subsequent exact prerelease ordinals must preserve the exact target, active base, and channel while keeping `.changeset/pre.json` coherent.
- Prerelease channels must reject `latest`, valid SemVer ranges, and leading `-` before confirmation or `changeset pre enter`.
- After `changeset pre enter`, verify `.changeset/pre.json` immediately has mode `pre` and the expected tag; do not run versioning if the postcondition fails.
- Preserve unconditional `npm install --package-lock-only` guidance and its rationale.
- Publication remains exclusively GitHub Release to `.github/workflows/publish.yml`; never run local `npm publish`, including with `--dry-run`.
- Do not modify `.github/workflows/publish.yml`, `package.json`, `package-lock.json`, `CHANGELOG.md`, `.changeset/*.md`, tags, npm state, runtime source, runtime fixtures, or release state.
- Do not reclassify pending Changesets fragments; that remains deferred to actual release preparation.
- Modify only the release skill and its existing eval JSON. This committed SDD plan is an exempt process artifact.
- Do not add implementation, test, helper, or script files.
- Use `npm run test:fast` for iterative broad feedback when no other heavy suite or subsession is running. Reserve serial full verification for the final gate.
- `npm run verify:staged` remains the standard pre-commit gate and is not behavioral evidence for `.agents/skills` content.

## Task 1: Separate exact release targets from Changesets intermediates

**Implementer tier:** Advanced

**Files:**

- Modify: `.agents/skills/npm-release-via-github-actions/SKILL.md:70-155`
- Modify: `.agents/skills/npm-release-via-github-actions/evals/evals.json:1-90`
- Read only: `.github/workflows/publish.yml`
- Read only: `node_modules/.sdd-semver-release-policy-target-channel/final-rereview-report.md`

**Interfaces:**

- Consumes: the existing full-candidate contract, candidate-class checks, channel guard, Changesets initial/subsequent pre-mode lifecycle, exact-version override, current eval IDs 1-13, and residual findings F-8/F-9.
- Produces: an explicit release-target/intermediate-candidate flow contract with one confirmation; safe channel transport and `pre.json` postcondition; contiguous eval IDs 1-16 for initial exact ordinal, subsequent exact ordinal, and option-like channel regressions.

- [ ] **Step 1: Run a RED assertion before editing**

Run this assertion against the current skill and evals:

```bash
node <<'NODE'
const fs = require('node:fs');
const skill = fs.readFileSync('.agents/skills/npm-release-via-github-actions/SKILL.md', 'utf8');
const { evals } = JSON.parse(fs.readFileSync('.agents/skills/npm-release-via-github-actions/evals/evals.json', 'utf8'));
const failures = [];
if (!/release target[^\n]*(?:sole|exactly one|one)[^\n]*confirm/i.test(skill)) failures.push('one confirmed release target');
if (!/intermediate (?:Changesets )?candidate|Changesets intermediate/i.test(skill)) failures.push('intermediate candidate model');
if (!/exact-target flow|exact (?:ordinal|target)[^\n]*(?:sole|only) confirmed/i.test(skill)) failures.push('exact target remains sole confirmation');
if (!/startsWith\("-"\)|leading `-`|leading hyphen/i.test(skill)) failures.push('option-like channel rejection');
if (!/pre\.json[^\n]*(?:expected tag|mode `pre`)|expected tag[^\n]*pre\.json/i.test(skill)) failures.push('pre enter postcondition');
for (const prompt of ['1.12.0-beta.5', '1.12.0-beta.9', 'prerelease tag --help']) {
  if (!evals.some((entry) => entry.prompt.includes(prompt))) failures.push(`eval prompt ${prompt}`);
}
if (failures.length) {
  console.error('missing composed-flow contracts:', failures.join(', '));
  process.exit(1);
}
NODE
```

Expected: FAIL with every listed contract missing. This is the RED proof; do not edit first.

- [ ] **Step 2: Reproduce the option-like channel failure without repository mutation**

Use a disposable Changesets fixture on branch `main`. Run the repository's installed Changesets CLI from the fixture, not against this worktree. Prove that `--help` is a strict-SemVer-compatible first prerelease identifier but is interpreted as an option by `pre enter`, and confirm no fixture `.changeset/pre.json` is created. Do not run `npm publish` or mutate repository release files.

Also use `semver` to assert:

```bash
node -e 'const semver=require("semver"); const v="1.12.0---help.0"; if (!semver.valid(v) || semver.validRange("--help") !== null) process.exit(1);'
```

Expected: PASS, demonstrating why candidate and range validation alone do not make the positional Changesets tag safe.

- [ ] **Step 3: Define the target and intermediate vocabulary before procedural branches**

Add concise definitions in step 3 of the release skill:

- **Release target:** the single version shown to the user for confirmation and ultimately tagged/published.
- **Changesets intermediate candidate:** the valid version Changesets is expected to emit before an allowed exact-version override; validate it, but never present it as a second release target.

State that confirmation happens exactly once per release attempt, after every applicable target, intermediate, class, channel, and pre-mode consistency check has passed and before mutation.

Include a compact flow table or equivalent structured list covering:

| Flow | Release target | Changesets intermediate | Confirmation |
| --- | --- | --- | --- |
| generated stable/prerelease | generated candidate | same version | generated target once |
| exact stable/prerelease | user exact version | Changesets-derived version | exact target once |
| final stable from pre mode | active prerelease base | stable Changesets result | stable base once |

Do not imply that an intermediate receives confirmation merely because it is validated.

- [ ] **Step 4: Make initial prerelease handling branch on generated versus exact target**

For an initial prerelease:

1. Derive the stable base and channel. When an exact prerelease was supplied, derive the channel from that exact target; if a separately named channel disagrees, stop and ask the user to resolve the conflict before confirmation.
2. Predict the Changesets intermediate as `<base>-<tag>.0` before mutation.
3. Validate both the release target and the intermediate with the full-candidate contract, candidate-class checks where applicable, and channel guard.
4. Generated-target flow: the intermediate is also the release target; confirm it once.
5. Exact-target flow: the exact ordinal remains the release target; confirm only it once, while explaining that Changesets may emit the validated intermediate before the documented override.
6. Enter pre mode only after that sole confirmation. Version normally, then apply the step 5 exact override and changelog-heading correction only if the actual Changesets result differs from the exact target.

The ordered procedure must never recommend or confirm `<base>-<tag>.0` after an exact ordinal has been selected as the release target.

- [ ] **Step 5: Make subsequent prerelease handling branch on generated versus exact target**

For an active pre-mode prerelease:

1. Require matching `.changeset/pre.json` base and channel. An exact target must have the same base and channel as active pre mode; otherwise stop before confirmation.
2. Run `npm run changelog:status`; treat its version as the Changesets intermediate candidate.
3. Validate the intermediate and the selected release target.
4. Generated-target flow: the status result is the release target; confirm it once.
5. Exact-target flow: the user exact ordinal is the release target; confirm only it once, and treat the status result only as the validated intermediate to be overridden after versioning when different.
6. Do not enter pre mode again. Keep `.changeset/pre.json` coherent for later prereleases and final stable exit.

Preserve the rule that an exact target must be greater than current, unpublished, and no lower in base compatibility than pending work.

- [ ] **Step 6: Reject option-like channels and verify pre-mode state**

Extend the existing channel guard so it rejects a channel beginning with `-` in addition to `latest` and valid SemVer ranges. Keep one guard implementation and apply it to all prerelease paths. A failed channel must stop before confirmation or mutation.

Immediately after a valid initial `pre enter`, add this required postcondition before versioning:

```bash
expected_tag='<tag>'
node -e 'const fs=require("node:fs"); const expected=process.argv[1]; const path=".changeset/pre.json"; if (!fs.existsSync(path)) { console.error("Changesets pre mode was not created"); process.exit(1); } const pre=JSON.parse(fs.readFileSync(path,"utf8")); if (pre.mode!=="pre" || pre.tag!==expected) { console.error("unexpected Changesets pre state:", pre.mode, pre.tag, "expected pre", expected); process.exit(1); }' "$expected_tag"
```

If the postcondition fails, stop and resolve or revert the failed pre-mode preparation before any `changeset version`, package/changelog edit, commit, tag, or release creation.

- [ ] **Step 7: Add exact-ordinal and option-like evals**

Append contiguous evals 14-16:

```json
{
  "id": 14,
  "prompt": "publish exact initial prerelease 1.12.0-beta.5; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should keep 1.12.0-beta.5 as the sole release target, derive and validate 1.12.0-beta.0 only as the predicted Changesets intermediate, confirm beta.5 exactly once before mutation, enter beta pre mode, verify pre.json, run Changesets versioning, and override the intermediate plus changelog heading to beta.5 without a second target confirmation.",
  "files": []
}
```

```json
{
  "id": 15,
  "prompt": "we are on 1.12.0-beta.5 in matching Changesets pre mode with a new patch changeset; publish exact prerelease 1.12.0-beta.9",
  "expected_output": "The assistant should require the same active base and beta channel, treat the Changesets status result such as beta.6 only as a validated intermediate, keep beta.9 as the sole release target, confirm beta.9 exactly once, run Changesets versioning without pre enter, then override the intermediate and changelog heading to beta.9 while preserving pre.json.",
  "files": []
}
```

```json
{
  "id": 16,
  "prompt": "make the next minor prerelease using prerelease tag --help; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should reject the leading-hyphen channel before confirmation or changeset pre enter because it is option-like, ask for a safe named channel, validate and confirm the replacement once, and verify pre.json mode and tag immediately after a later valid pre enter before versioning.",
  "files": []
}
```

Tighten evals 6-7 only as needed to make generated-target single-confirmation semantics explicit. Do not add unrelated workflow-defense scenarios.

- [ ] **Step 8: Run GREEN flow assertions and JSON checks**

Re-run Step 1. Expected: PASS.

Run:

```bash
node <<'NODE'
const { evals } = require('./.agents/skills/npm-release-via-github-actions/evals/evals.json');
const ids = evals.map(({ id }) => id);
const expected = Array.from({ length: 16 }, (_, index) => index + 1);
if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`eval ids are not contiguous 1-16: ${ids}`);
for (const id of [14, 15]) {
  const text = evals.find((entry) => entry.id === id).expected_output;
  if (!/sole release target/.test(text) || !/intermediate/.test(text) || !/exactly once/.test(text)) throw new Error(`eval ${id} does not pin exact-target flow`);
}
const optionEval = evals.find((entry) => entry.id === 16).expected_output;
if (!/leading-hyphen|option-like/.test(optionEval) || !/pre\.json/.test(optionEval)) throw new Error('eval 16 does not pin channel transport and pre-mode state');
NODE
```

Expected: PASS.

- [ ] **Step 9: Run focused, fast, and scope verification**

Run the stale-policy search and require no matches:

```bash
rg -n 'CalVer|YYYYMM|1\.20[0-9]{4}\.' \
  .agents/skills/changeset-changelog \
  .agents/skills/npm-release-via-github-actions
```

Then, with no other heavy suite or subsession running:

```bash
git diff --check
npm run test:fast
npm run verify:staged
git status --short
```

Expected: formatting passes; `test:fast` passes as broad iterative feedback; the standard staged gate passes; only the two authorized skill files are modified. Record separately that `verify:staged` does not behaviorally validate `.agents/skills` content.

- [ ] **Step 10: Commit the residual correction**

```bash
git add \
  .agents/skills/npm-release-via-github-actions/SKILL.md \
  .agents/skills/npm-release-via-github-actions/evals/evals.json
git commit -m "docs(skills): separate exact prerelease targets"
```

Expected: one commit containing only the two authorized files, with the pre-commit gate passing.
