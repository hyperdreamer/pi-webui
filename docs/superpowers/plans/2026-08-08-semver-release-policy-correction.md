# SemVer Release Policy Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the obsolete CalVer release policy in the two repository release skills, and their eval fixtures, with ordinary SemVer plus an explicit version-confirmation gate.

**Architecture:** Two tasks, one per skill. Task 1 corrects the bump-classification semantics in `changeset-changelog`, which Task 2 then references when correcting release-target selection and version-enforcement machinery in `npm-release-via-github-actions`. Both tasks are documentation-only edits inside `.agents/skills/`, verified by executable assertion commands because no repository test covers these paths.

**Tech Stack:** Markdown skill documents, JSON eval fixtures, Node 22 for assertion scripts, `rg` for text searches.

## Global Constraints

- Edit only these four files: `.agents/skills/changeset-changelog/SKILL.md`, `.agents/skills/changeset-changelog/evals/evals.json`, `.agents/skills/npm-release-via-github-actions/SKILL.md`, `.agents/skills/npm-release-via-github-actions/evals/evals.json`.
- Do not change `package.json`, `package-lock.json`, `CHANGELOG.md`, any `.changeset/*.md` fragment, any git tag, or anything on npm.
- Do not prepare or publish a release.
- Do not edit runtime tests that use date-shaped versions as version-comparison input data: `src/server/piWebUiStatus.test.ts`, `pi-webui-plugins/updates/updatesLogic.test.ts`, `src/docker/piWebUiDockerDocs.test.ts`. Those fixtures test version comparison, not release policy.
- Do not add a Changeset. `package.json#files` does not list `.agents`, so these files are not shipped to package consumers.
- Do not add new files. No new test file, no new script.
- The repo's version scheme is ordinary SemVer `MAJOR.MINOR.PATCH`; the current version is `1.11.3`.
- Publication stays exclusively through a published GitHub Release triggering `.github/workflows/publish.yml`. Local `npm publish` remains forbidden.
- Preserve the lockfile-synchronization guidance and its rationale in `npm-release-via-github-actions/SKILL.md`; only the phrase naming CalVer enforcement may change.
- `npm run verify:staged` does not validate `.agents/skills` files. It runs whole-project typecheck and Knip only, and reports no ESLint and no related Vitest coverage for these paths. Run it before committing as the standard gate, but do not treat it as evidence for this change.

## Task 1: Correct Changeset Bump Policy To SemVer

**Implementer tier:** Standard

**Files:**

- Modify: `.agents/skills/changeset-changelog/SKILL.md:54-64`
- Modify: `.agents/skills/changeset-changelog/SKILL.md:102`
- Modify: `.agents/skills/changeset-changelog/evals/evals.json:12-16`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: the SemVer bump vocabulary that Task 2 references, namely `patch` for backward-compatible fixes and maintenance, `minor` for backward-compatible new features and capabilities, and `major` only for user-requested breaking changes.

- [ ] **Step 1: Write the failing contract assertion**

Save this command; it is the task's test. Run it from the repository root. Do not commit it as a file.

```bash
node -e '
const fs = require("node:fs");
const skill = fs.readFileSync(".agents/skills/changeset-changelog/SKILL.md", "utf8");
const evals = JSON.parse(fs.readFileSync(".agents/skills/changeset-changelog/evals/evals.json", "utf8"));
const eval2 = evals.evals.find((e) => e.id === 2);
const failures = [];
if (/CalVer|YYYYMM/u.test(skill)) failures.push("SKILL.md still mentions CalVer or YYYYMM");
if (/1\.20[0-9]{4}\./u.test(skill)) failures.push("SKILL.md still contains a date-shaped version literal");
if (/do not use for this repo/u.test(skill)) failures.push("SKILL.md still forbids the minor bump");
if (/Do not ask whether to choose a patch increase or a date change/u.test(skill)) failures.push("SKILL.md still forbids asking the user");
if (!/ordinary semver/iu.test(skill)) failures.push("SKILL.md does not state the ordinary semver scheme");
if (!/`minor`: backward-compatible new features/u.test(skill)) failures.push("SKILL.md lacks the semver minor rule");
if (/YYYYMM/u.test(eval2.expected_output)) failures.push("eval 2 still references YYYYMM");
if (!/minor/u.test(eval2.expected_output)) failures.push("eval 2 does not require minor for a backward-compatible CLI option");
if (failures.length > 0) { console.error("FAIL"); for (const f of failures) console.error("  - " + f); process.exit(1); }
console.log("PASS: changeset-changelog encodes ordinary semver");
'
```

- [ ] **Step 2: Run the assertion and confirm it fails**

Run the command from Step 1.
Expected: FAIL, listing at least `SKILL.md still mentions CalVer or YYYYMM`, `SKILL.md still contains a date-shaped version literal`, `SKILL.md still forbids the minor bump`, `SKILL.md still forbids asking the user`, and `eval 2 still references YYYYMM`.

- [ ] **Step 3: Replace the bump-selection section**

In `.agents/skills/changeset-changelog/SKILL.md`, replace everything from the line `## Choosing patch/minor/major` up to and including the paragraph that begins `During release prep, the npm release skill always computes the version`. Stop before the line `## Writing good changeset text`. Use exactly this text:

```md
## Choosing patch/minor/major

This repo uses ordinary semver: `MAJOR.MINOR.PATCH` (for example, `1.11.3`). Choose the Changeset bump type from the change's compatibility impact, not from how large the work felt:

- `patch`: backward-compatible bug fixes, documentation corrections, polish, release-process improvements, and maintenance changes that add no new public capability.
- `minor`: backward-compatible new features and user-facing capabilities, such as a new CLI option, a new configuration key, a new panel, or new API surface that existing users are unaffected by.
- `major`: breaking changes, and only when the user explicitly requests a breaking/major release. Breaking changes can include changes to CLI, install expectations, package API, config, data formats, supported runtime behavior, and narrowed peer dependency ranges.

If you believe a change is breaking but the user has not explicitly requested a major release, pause and ask the user to confirm whether to release it as a breaking major version or change the work so it remains non-breaking. Do not infer or perform a major version bump on your own.

During release prep, the npm release skill derives the release version from the highest bump type among pending changesets and confirms that target with the user before touching version files. If a pending fragment's bump type does not match its actual compatibility impact, raise the mismatch as part of that confirmation instead of silently rewriting the fragment.
```

- [ ] **Step 4: Replace the date-shaped commit example**

In the same file, in the Conventional Commit guidance list, replace this line:

```md
- `chore(release): v1.202605.4`
```

with:

```md
- `chore(release): v1.11.4`
```

- [ ] **Step 5: Correct eval 2's expected output**

In `.agents/skills/changeset-changelog/evals/evals.json`, replace the `expected_output` value of the entry with `"id": 2` with exactly this string:

```text
The assistant should add a changeset fragment for @hyperdreamer/pi-webui using minor for a backward-compatible new CLI option, use patch only for backward-compatible fixes and maintenance, reserve major for explicit user-requested breaking releases, and keep the text user-facing.
```

Leave that entry's `id`, `prompt`, and `files` unchanged, and leave evals 1, 3, and 4 untouched.

- [ ] **Step 6: Run the assertion and confirm it passes**

Run the command from Step 1.
Expected: PASS, printing `PASS: changeset-changelog encodes ordinary semver`.

- [ ] **Step 7: Confirm the eval file is still valid JSON with four entries**

```bash
node -e '
const e = require("./.agents/skills/changeset-changelog/evals/evals.json");
if (e.evals.length !== 4) { console.error("expected 4 evals, found " + String(e.evals.length)); process.exit(1); }
if (e.skill_name !== "changeset-changelog") { console.error("skill_name changed"); process.exit(1); }
console.log("PASS: valid JSON, 4 evals, skill_name intact");
'
```

Expected: PASS.

- [ ] **Step 8: Confirm nothing outside the two files changed**

```bash
git status --short
git diff --check
```

Expected from `git status --short`: exactly two modified paths, `.agents/skills/changeset-changelog/SKILL.md` and `.agents/skills/changeset-changelog/evals/evals.json`. If `package.json`, `package-lock.json`, `CHANGELOG.md`, or any `.changeset/` path appears, revert that path before continuing. Expected from `git diff --check`: no output.

- [ ] **Step 9: Commit**

```bash
git add .agents/skills/changeset-changelog/SKILL.md .agents/skills/changeset-changelog/evals/evals.json
git commit -m "docs(skills): use semver bump rules for changesets"
```

## Task 2: Correct Release Target Policy And Enforcement Machinery

**Implementer tier:** Advanced

**Files:**

- Modify: `.agents/skills/npm-release-via-github-actions/SKILL.md:62-108`
- Modify: `.agents/skills/npm-release-via-github-actions/evals/evals.json:5-27`

**Interfaces:**

- Consumes: the SemVer bump vocabulary established by Task 1 in `.agents/skills/changeset-changelog/SKILL.md`, namely `patch` for backward-compatible fixes and maintenance, `minor` for backward-compatible new features and capabilities, and `major` only for user-requested breaking changes.
- Produces: a release procedure whose version target is derived from pending changesets and confirmed by the user before any mutation, with `npm version --no-git-tag-version` and the manual `CHANGELOG.md` heading edit reduced to the exact-version-request case.

- [ ] **Step 1: Write the failing contract assertion**

Save this command; it is the task's test. Run it from the repository root. Do not commit it as a file.

```bash
node -e '
const fs = require("node:fs");
const skill = fs.readFileSync(".agents/skills/npm-release-via-github-actions/SKILL.md", "utf8");
const evals = JSON.parse(fs.readFileSync(".agents/skills/npm-release-via-github-actions/evals/evals.json", "utf8"));
const byId = new Map(evals.evals.map((e) => [e.id, e]));
const failures = [];
if (/CalVer/u.test(skill)) failures.push("SKILL.md still mentions CalVer");
if (/YYYYMM/u.test(skill)) failures.push("SKILL.md still mentions YYYYMM");
if (/date \+%Y%m/u.test(skill)) failures.push("SKILL.md still derives a version from the date");
if (/Do not ask whether/u.test(skill)) failures.push("SKILL.md still forbids asking the user");
if (/must use `patch` even for new features/u.test(skill)) failures.push("SKILL.md still forces features into patch");
if (!/Determine the release version/u.test(skill)) failures.push("SKILL.md lacks the semver target step");
if (!/Confirm the recommended target with the user before editing version files/u.test(skill)) failures.push("SKILL.md lacks the confirmation gate sentence");
if (!/npm install --package-lock-only/u.test(skill)) failures.push("lockfile sync command was lost");
if (!/resurfaces as an unexpected diff after the next `npm install`/u.test(skill)) failures.push("lockfile sync rationale was lost");
for (const id of [1, 2, 4]) {
  const e = byId.get(id);
  if (e === undefined) { failures.push("eval " + String(id) + " is missing"); continue; }
  const text = e.prompt + " " + e.expected_output;
  if (/CalVer|YYYYMM/u.test(text)) failures.push("eval " + String(id) + " still references CalVer or YYYYMM");
  if (/1\.20[0-9]{4}\./u.test(text)) failures.push("eval " + String(id) + " still contains a date-shaped version literal");
}
if (failures.length > 0) { console.error("FAIL"); for (const f of failures) console.error("  - " + f); process.exit(1); }
console.log("PASS: npm-release policy is semver with a confirmation gate");
'
```

- [ ] **Step 2: Run the assertion and confirm it fails**

Run the command from Step 1.
Expected: FAIL, listing at least `SKILL.md still mentions CalVer`, `SKILL.md still mentions YYYYMM`, `SKILL.md still derives a version from the date`, `SKILL.md still forbids asking the user`, `SKILL.md still forces features into patch`, `SKILL.md lacks the semver target step`, `SKILL.md lacks the confirmation gate sentence`, `eval 1 still references CalVer or YYYYMM`, `eval 2 still contains a date-shaped version literal`, and `eval 4 still references CalVer or YYYYMM`.

The two lockfile assertions are regression guards rather than RED signals. They already pass before any edit, and must still pass afterward.

- [ ] **Step 3: Correct the changeset-review bullets in step 2 of the workflow**

In `.agents/skills/npm-release-via-github-actions/SKILL.md`, inside the numbered item `2. **Review and normalize pending changesets**`, replace these two bullets:

```md
   - For `pi-webui`, non-breaking changesets must use `patch` even for new features. The package uses CalVer shaped as semver: `MAJOR.YYYYMM.PATCH`. The semver `minor` position is the release month, not feature size.
   - If a pending changeset uses `minor` for a non-breaking change, edit its frontmatter to `patch` before versioning. Do not ask the user whether to use a patch increase or date change.
```

with:

```md
   - This repo uses ordinary semver. Use `patch` for backward-compatible fixes and maintenance, `minor` for backward-compatible new features and capabilities, and `major` only for a breaking release the user explicitly requested.
   - If a pending changeset's bump type does not match its actual compatibility impact, do not rewrite it silently. Carry the corrected classification into the version recommendation in step 3, and apply the correction to the fragment only after the user confirms the target.
```

Also rename the numbered item's title from `2. **Review and normalize pending changesets**` to `2. **Review pending changesets**`, since normalization is no longer automatic.

Leave the surrounding bullets in that item unchanged, including the `changelog:status` command, the "no changesets" guidance, the user-facing text check, the `major`-on-request bullet, and the breaking-change pause bullet.

- [ ] **Step 4: Replace the version-computation step**

Replace the whole numbered item `3. **Compute the `pi-webui` CalVer version**`, from its heading line through its last bullet ending `instead of inventing a non-CalVer version.`, with exactly this text. Stop before `4. **Generate changelog and version files**`.

```md
3. **Determine the release version**
   - Read the current version from `package.json`.
   - Determine the highest bump type among pending changesets, ordering `major` above `minor` above `patch`.
   - Apply that bump to the current version to get the recommended target. From `1.11.3`, a highest pending bump of `patch` gives `1.11.4`, `minor` gives `1.12.0`, and `major` gives `2.0.0`.
   - Confirm the recommended target with the user before editing version files, committing, tagging, or publishing. Show the current version and where it came from, the recommended target, the tag that will be created, and which pending change drives the bump level.
   - If the user supplies an exact version, accept it only when it is valid semver, greater than the current version, absent from npm, and not lower than the minimum target implied by the highest pending bump. If a check fails, say which one and ask again rather than adjusting the number yourself.
   - Never infer a `major` bump. If the pending changes look breaking and the user has not asked for a breaking release, raise that during confirmation.
   - If npm already has the confirmed version, stop and ask for a different target. npm rejects republishing an existing version.
   - Tag names follow the existing convention in this repository, `v<version>`.
```

- [ ] **Step 5: Make version enforcement conditional in step 4 of the workflow**

Inside the numbered item `4. **Generate changelog and version files**`, make three edits and leave every other bullet unchanged.

First, replace this bullet text:

```md
   - Run the Changesets version step after normalizing non-breaking changesets to `patch`:
```

with:

```md
   - Run the Changesets version step after the user has confirmed the target:
```

Second, replace this bullet and its code fence:

```md
   - Changesets may produce a semver bump that does not match the computed CalVer target, especially on the first release of a new month. That is expected; enforce the computed target with:
     ```bash
     npm version <computed-calver-version> --no-git-tag-version
     ```
   - Update the newly generated `CHANGELOG.md` heading to match the computed CalVer version if Changesets used a different heading. This manual changelog heading edit is acceptable during release prep; normal development should still use changeset fragments instead.
```

with:

```md
   - Changesets derives the version from the pending fragments, so its result should already equal the confirmed target. Compare the two. Only if the user requested an exact version that differs from the Changesets result, enforce it with:
     ```bash
     npm version <confirmed-version> --no-git-tag-version
     ```
   - If you enforced a different version in the previous bullet, update the newly generated `CHANGELOG.md` heading to match it. This manual changelog heading edit is acceptable during release prep; normal development should still use changeset fragments instead.
   - If the Changesets result and the confirmed target disagree for any other reason, stop and reconcile it with the user rather than overwriting the version silently.
```

Third, in the lockfile-synchronization bullet, replace only the phrase:

```md
the CalVer-enforcing `npm version --no-git-tag-version`
```

with:

```md
the exact-version-enforcing `npm version --no-git-tag-version`
```

Keep the rest of that bullet, its `npm install --package-lock-only` fence, the lockfile comparison command, and the mismatch warning exactly as they are. That guidance records a real packaging failure and is independent of the version scheme.

- [ ] **Step 6: Correct eval 1's expected output**

In `.agents/skills/npm-release-via-github-actions/evals/evals.json`, replace the `expected_output` of the entry with `"id": 1` with exactly this string:

```text
The assistant should inspect package.json, pending Changesets, and the GitHub Actions publish workflow; determine the highest pending bump type; recommend an ordinary semver target derived from it; confirm that target with the user before editing version files; run changeset version; sync package-lock.json to the final version; avoid local npm publish; run verification; commit and push; create a GitHub Release using the generated changelog notes; monitor the publish workflow; and verify npm. It should not compute a date-based version.
```

- [ ] **Step 7: Correct eval 2's prompt and expected output**

Replace the `prompt` of the entry with `"id": 2` with exactly:

```text
bump npm to 1.12.0 and publish it
```

Replace that same entry's `expected_output` with exactly:

```text
The assistant should validate the requested version as semver that is greater than the current version, unpublished, and not lower than the minimum target implied by the pending changesets, then use it. It should avoid local npm publish, generate CHANGELOG.md through Changesets, enforce the requested version with --no-git-tag-version only if the Changesets result differs, sync the lockfile, push a release commit, create a GitHub Release that triggers publish.yml, and report action and npm status.
```

- [ ] **Step 8: Reframe eval 4**

Under the corrected policy, a non-breaking feature marked `minor` is correctly classified, so eval 4's original premise no longer describes a fault. Replace the entry with `"id": 4` so its `prompt` is exactly:

```text
make a new release; one pending changeset says patch but it adds a whole new CLI flag
```

and its `expected_output` is exactly:

```text
The assistant should notice that a backward-compatible new CLI flag is a minor change rather than a patch, recommend a minor target derived from the corrected bump type, and present the current version and recommended target for confirmation. It should not rewrite the changeset fragment or edit version files before the user confirms, and it should not compute a date-based version.
```

Keep that entry's `id` and `files` unchanged, and leave evals 3 and 5 untouched.

- [ ] **Step 9: Run the assertion and confirm it passes**

Run the command from Step 1.
Expected: PASS, printing `PASS: npm-release policy is semver with a confirmation gate`.

- [ ] **Step 10: Confirm the eval file is still valid JSON with five entries**

```bash
node -e '
const e = require("./.agents/skills/npm-release-via-github-actions/evals/evals.json");
if (e.evals.length !== 5) { console.error("expected 5 evals, found " + String(e.evals.length)); process.exit(1); }
if (e.skill_name !== "npm-release-via-github-actions") { console.error("skill_name changed"); process.exit(1); }
const ids = e.evals.map((x) => x.id).join(",");
if (ids !== "1,2,3,4,5") { console.error("eval ids changed: " + ids); process.exit(1); }
console.log("PASS: valid JSON, 5 evals, ids intact");
'
```

Expected: PASS.

- [ ] **Step 11: Confirm no stale policy survives anywhere in either skill**

```bash
rg -n 'CalVer|YYYYMM|1\.20[0-9]{4}\.' .agents/skills/changeset-changelog .agents/skills/npm-release-via-github-actions
rg -n 'Do not ask whether|must use `patch` even for new features|do not use for this repo' .agents/skills/changeset-changelog .agents/skills/npm-release-via-github-actions
```

Expected: no matches from either command, exit status 1 each. The first command's date-literal pattern is required because the commit example corrected in Task 1 used a date-shaped version without naming CalVer, so a keyword-only search would miss it. The second command catches any anti-confirmation or forced-patch directive left behind in either skill, including ones Task 1 was meant to remove.

- [ ] **Step 12: Confirm scope and whitespace hygiene**

```bash
git status --short
git diff --check
```

Expected from `git status --short`: only the two `npm-release-via-github-actions` paths as modified. No `package.json`, `package-lock.json`, `CHANGELOG.md`, `.changeset/`, or runtime test path may appear. Expected from `git diff --check`: no output.

- [ ] **Step 13: Run the repository pre-commit gate**

Stage the two files first, then run:

```bash
npm run verify:staged
```

This executes the whole-project typecheck and Knip, and will report no ESLint and no related Vitest coverage for these paths, which is expected. The repository's pre-commit hook runs the same command again during Step 14, so a failure here means Step 14 will also fail. It is a regression guard for the rest of the repository, not evidence about this change.

- [ ] **Step 14: Commit**

```bash
git add .agents/skills/npm-release-via-github-actions/SKILL.md .agents/skills/npm-release-via-github-actions/evals/evals.json
git commit -m "docs(skills): derive release version from semver changesets"
```
