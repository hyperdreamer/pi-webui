# SemVer Policy Final-Review Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve carried final-review findings F-1 and F-2 by reconciling committed planning-artifact scope and restoring complete SemVer prerelease release guidance.

**Architecture:** Task 1 corrects the approved design and original implementation plan so their whole-branch scope explicitly includes required SDD process artifacts and specifies the measured Changesets prerelease lifecycle. Task 2 implements that lifecycle in the npm release skill and adds initial/subsequent beta evals. The final review must inspect the original merge base through the new HEAD and reconcile F-1 and F-2 from the blocked run.

**Tech Stack:** Markdown skill/spec/plan documents, JSON eval fixtures, Changesets 2.31 prerelease mode, Node 22 assertion scripts, `rg`.

## Global Constraints

- Whole-branch tracked changes are limited to the four policy files from the original plan, the original committed design spec, the original committed implementation plan, and this committed remediation plan. This remediation plan is a required pre-run process artifact and is exempt from task-deliverable file restrictions.
- Task 1 may modify only `docs/superpowers/specs/2026-08-08-semver-release-policy-correction-design.md` and `docs/superpowers/plans/2026-08-08-semver-release-policy-correction.md`.
- Task 2 may modify only `.agents/skills/npm-release-via-github-actions/SKILL.md` and `.agents/skills/npm-release-via-github-actions/evals/evals.json`.
- Do not change `package.json`, `package-lock.json`, `CHANGELOG.md`, pending `.changeset/*.md` fragments, tags, npm state, runtime tests, or the already-corrected `changeset-changelog` skill files.
- Do not prepare or publish a release.
- Do not add implementation, runtime, test, or script files. SDD specs and plans are required process artifacts, not package deliverables.
- Preserve ordinary SemVer `MAJOR.MINOR.PATCH`; do not reintroduce CalVer, `YYYYMM`, or date-derived targets.
- Preserve stable-release bump rules, the pre-mutation target confirmation gate, GitHub Actions-only publishing, conditional exact-version enforcement, and unconditional lockfile synchronization with its rationale.
- Prerelease validation compares the requested prerelease's base release (for example, `1.12.0` from `1.12.0-beta.1`) with the minimum stable target implied by pending changesets; it never compares the prerelease itself against that stable minimum.
- Use Changesets pre mode for new prerelease lines and subsequent prereleases, and `changeset pre exit` for the final stable release. If a package is already prerelease but `.changeset/pre.json` is absent or inconsistent, stop instead of guessing.
- `npm run verify:staged` is only a repository-wide regression gate for `.agents/skills` changes; explicit Node assertions and JSON parsing provide the direct evidence.

## Task 1: Reconcile Planning Scope And Prerelease Design

**Implementer tier:** Standard

**Files:**

- Modify: `docs/superpowers/specs/2026-08-08-semver-release-policy-correction-design.md:32-38`
- Modify: `docs/superpowers/specs/2026-08-08-semver-release-policy-correction-design.md:65-95`
- Modify: `docs/superpowers/plans/2026-08-08-semver-release-policy-correction.md:13-24`

**Interfaces:**

- Consumes: carried final-review findings F-1 and F-2 from `node_modules/.sdd-semver-release-policy/final-review-report.md`.
- Produces: planning documents that explicitly exempt committed SDD process artifacts from task-only file constraints and define initial prerelease, subsequent prerelease, exact prerelease, and final stable semantics for Task 2.

- [ ] **Step 1: Run the failing planning-contract assertion**

Run from the worktree root. Do not save this as a repository file.

```bash
node -e '
const fs = require("node:fs");
const spec = fs.readFileSync("docs/superpowers/specs/2026-08-08-semver-release-policy-correction-design.md", "utf8");
const plan = fs.readFileSync("docs/superpowers/plans/2026-08-08-semver-release-policy-correction.md", "utf8");
const failures = [];
if (!/committed process artifacts/iu.test(plan)) failures.push("plan does not exempt committed process artifacts");
if (/^- Edit only these four files:/mu.test(plan)) failures.push("plan still applies the four-file limit to the whole range");
if (/^- Do not add new files\. No new test file, no new script\./mu.test(plan)) failures.push("plan still forbids its own process artifacts");
if (!/Changesets prerelease mode/iu.test(spec)) failures.push("spec does not define Changesets prerelease mode");
if (!/pre enter <tag>/u.test(spec)) failures.push("spec lacks initial prerelease entry");
if (!/pre exit/u.test(spec)) failures.push("spec lacks final stable exit");
if (!/base release/iu.test(spec)) failures.push("spec lacks prerelease base-release validation");
if (failures.length) { console.error("FAIL"); failures.forEach((f) => console.error("  - " + f)); process.exit(1); }
console.log("PASS: planning scope and prerelease design reconciled");
'
```

Expected before edits: FAIL with all seven messages.

- [ ] **Step 2: Clarify the design's implementation scope**

In the design spec's `## Approach` section, replace the sentence `Use a focused policy correction in four repository-only files:` with:

```md
Use a focused policy correction in four repository-only policy files. The committed design and implementation plans are required SDD process artifacts; they are part of whole-branch history but are not task deliverables and do not violate the four-policy-file implementation scope:
```

- [ ] **Step 3: Add the measured prerelease design**

In the design spec, insert this section after `### Release target policy` and before `### Version-enforcement machinery`:

```md
### Prerelease release lines

Ordinary SemVer includes prereleases. Validate a requested prerelease separately from a stable target:

- It must be valid SemVer, greater than the current package version, and unpublished.
- Strip prerelease and build metadata to obtain its base release. For example, the base release of `1.12.0-beta.1` is `1.12.0`.
- The base release must be at least the minimum stable target implied by the highest pending Changeset bump. A next-minor `1.12.0-beta.1` is therefore valid when pending work requires `1.12.0`, even though SemVer correctly orders the prerelease below stable `1.12.0`.
- An exact major-line prerelease still counts as an explicit user request for that major line; never infer it.

Use Changesets prerelease mode rather than treating a prerelease package as a stable version:

1. For the first prerelease on a line, confirm the complete target before mutation, run `npm run changeset -- pre enter <tag>`, then run the normal Changesets version step. Changesets creates `<base>-<tag>.0` and `.changeset/pre.json`.
2. For subsequent prereleases, require `.changeset/pre.json` in `pre` mode with the same base line and tag. `npm run changelog:status` is authoritative for the next prerelease target; confirm it before `npm run release:version`. Do not enter pre mode again.
3. For the final stable release, confirm the prerelease's base version, then run `npm run changeset -- pre exit` followed by `npm run release:version`. Changesets writes the stable base version and removes `.changeset/pre.json`.
4. If the user requested an exact prerelease ordinal that differs from Changesets output, the existing conditional `npm version <confirmed-version> --no-git-tag-version` and changelog-heading correction apply after versioning. Keep `.changeset/pre.json` committed so later prereleases and final exit remain coherent.

The publish workflow already derives the npm dist-tag from the first prerelease identifier. For this repository, an unnamed prerelease request uses `beta`, matching the established `v1.11.0-beta.*` tags; still confirm the exact target before mutation.
```

- [ ] **Step 4: Correct the original plan's whole-range constraints**

In the original plan's `## Global Constraints`, replace the first constraint with:

```md
- Implementation task deliverables are limited to these four policy files: `.agents/skills/changeset-changelog/SKILL.md`, `.agents/skills/changeset-changelog/evals/evals.json`, `.agents/skills/npm-release-via-github-actions/SKILL.md`, `.agents/skills/npm-release-via-github-actions/evals/evals.json`. Committed process artifacts under `docs/superpowers/specs/` and `docs/superpowers/plans/`, including this plan and its approved design, are exempt from this task-level restriction and remain part of whole-branch review.
```

Replace `- Do not add new files. No new test file, no new script.` with:

```md
- Do not add implementation, runtime, test, or script files. Committed SDD spec and plan files are required process artifacts and are exempt from this restriction.
```

Add this constraint immediately after the ordinary-SemVer constraint:

```md
- Preserve SemVer prerelease releases: validate a requested prerelease by its base release line, use Changesets pre mode for initial and subsequent prereleases, and use `changeset pre exit` for the final stable release.
```

- [ ] **Step 5: Run the planning assertion and document the carried findings**

Run Step 1 again.
Expected: `PASS: planning scope and prerelease design reconciled`.

Also run:

```bash
git diff --check
git status --short
```

Expected: only the two planning documents modified, with no whitespace errors. In the commit message/report, identify this as the resolution mechanism for F-1 and the design correction for F-2.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-08-semver-release-policy-correction-design.md docs/superpowers/plans/2026-08-08-semver-release-policy-correction.md
git commit -m "docs: reconcile SemVer prerelease policy scope"
```

## Task 2: Restore SemVer Prerelease Release Workflow

**Implementer tier:** Advanced

**Files:**

- Modify: `.agents/skills/npm-release-via-github-actions/SKILL.md:75-108`
- Modify: `.agents/skills/npm-release-via-github-actions/evals/evals.json:1-34`

**Interfaces:**

- Consumes: Task 1's prerelease design: base-release comparison, Changesets `pre enter`, active-pre subsequent releases, `pre exit`, and conditional exact-ordinal enforcement.
- Produces: release guidance and seven eval fixtures covering stable SemVer plus initial and subsequent beta releases.

- [ ] **Step 1: Run the failing prerelease-policy assertion**

Run from the worktree root. Do not save it as a repository file.

```bash
node -e '
const fs = require("node:fs");
const skill = fs.readFileSync(".agents/skills/npm-release-via-github-actions/SKILL.md", "utf8");
const evalDoc = JSON.parse(fs.readFileSync(".agents/skills/npm-release-via-github-actions/evals/evals.json", "utf8"));
const failures = [];
if (!/base release/iu.test(skill)) failures.push("skill lacks prerelease base-release validation");
if (!/changeset -- pre enter <tag>/u.test(skill)) failures.push("skill lacks initial pre-mode entry");
if (!/changeset -- pre exit/u.test(skill)) failures.push("skill lacks final stable exit");
if (!/\.changeset\/pre\.json/u.test(skill)) failures.push("skill lacks durable pre-mode state checks");
if (!/subsequent prerelease/iu.test(skill)) failures.push("skill lacks subsequent prerelease flow");
if (evalDoc.evals.length !== 7) failures.push("eval suite does not contain 7 scenarios");
const initial = evalDoc.evals.find((e) => e.id === 6);
const subsequent = evalDoc.evals.find((e) => e.id === 7);
if (!/beta\.0/u.test(initial?.expected_output ?? "")) failures.push("eval 6 does not cover initial beta.0");
if (!/beta\.1/u.test(subsequent?.expected_output ?? "")) failures.push("eval 7 does not cover subsequent beta.1");
if (/CalVer|YYYYMM|1\.20[0-9]{4}\./u.test(skill + JSON.stringify(evalDoc))) failures.push("stale date policy reappeared");
if (failures.length) { console.error("FAIL"); failures.forEach((f) => console.error("  - " + f)); process.exit(1); }
console.log("PASS: prerelease SemVer workflow is complete");
'
```

Expected before edits: FAIL for the first eight checks; the stale-date regression guard must already pass.

- [ ] **Step 2: Split exact stable and prerelease validation**

In release workflow step 3, replace the bullet beginning `If the user supplies an exact version` with these bullets:

```md
   - If the user supplies an exact stable version, accept it only when it is valid semver, greater than the current version, absent from npm, and not lower than the minimum stable target implied by the highest pending bump. If a check fails, say which one and ask again rather than adjusting the number yourself.
   - If the user supplies an exact prerelease, require valid semver, a version greater than the current version, and an unpublished npm version. Strip prerelease and build metadata to obtain its base release; that base release, not the prerelease itself, must be at least the minimum stable target implied by pending changesets. For example, `1.12.0-beta.1` is valid for a pending minor target of `1.12.0` even though it correctly sorts below stable `1.12.0`.
   - An exact prerelease on a new major line is an explicit request for that major line. Never infer a major prerelease from pending work.
```

- [ ] **Step 3: Insert a dedicated prerelease-mode workflow**

Insert this numbered item after `3. **Determine the release version**` and before the current changelog/version item. Renumber the existing items 4 through 9 as 5 through 10.

```md
4. **Prepare Changesets prerelease mode when requested**
   - Stable releases skip this step.
   - For the first prerelease on a release line, derive the stable base target from pending changesets. If the user did not name a prerelease tag, use `beta`, matching this repository's established tags. Recommend and confirm `<base>-<tag>.0` before mutation, then enter pre mode:
     ```bash
     npm run changeset -- pre enter <tag>
     ```
     The following version step must create `.changeset/pre.json`; commit it with the release prep.
   - For a subsequent prerelease, require `.changeset/pre.json` with `"mode": "pre"`, the same tag, and the same release base. Run `npm run changelog:status`; its next prerelease version is authoritative. Confirm that target before versioning and do not enter pre mode again.
   - If the package version is already a prerelease but `.changeset/pre.json` is absent, exited, or names a different tag/base, stop and explain the inconsistent prerelease state instead of guessing or recreating it.
   - For the final stable release from pre mode, confirm the current prerelease's base version before mutation, then exit pre mode:
     ```bash
     npm run changeset -- pre exit
     ```
     Run the normal version step next; it must write the stable base version and remove `.changeset/pre.json`.
   - If the user confirmed an exact prerelease ordinal different from Changesets output, use the conditional exact-version override and changelog-heading correction in step 5. Keep the active `.changeset/pre.json` so subsequent prereleases and final stable exit remain coherent.
   - `.github/workflows/publish.yml` derives the npm dist-tag from the first prerelease identifier, so `1.12.0-beta.1` publishes under `beta` while stable versions publish under `latest`.
```

- [ ] **Step 4: Keep generation and lockfile rules coherent**

In the renumbered `5. **Generate changelog and version files**` item:

- Keep the existing pre-confirmation gate, Changesets version command, conditional exact-version override, conditional changelog-heading correction, disagreement stop, review guidance, no-local-tag rule, and lockfile synchronization text.
- Change `Changesets derives the version from the pending fragments` to `Changesets derives the version from the pending fragments and active prerelease state`.
- Change the mismatch sentence to distinguish active pre mode: the generated version should equal the confirmed stable or prerelease target; exact user-requested ordinals may use the existing override.
- Do not weaken or abbreviate the `npm install --package-lock-only` rationale or comparison command.

- [ ] **Step 5: Add initial and subsequent beta evals**

Append these objects after eval 5, preserving valid JSON and IDs 1-5 unchanged:

```json
{
  "id": 6,
  "prompt": "make the next minor beta release; current is 1.11.3 and the pending changesets require minor",
  "expected_output": "The assistant should derive stable base 1.12.0, recommend and explicitly confirm 1.12.0-beta.0 before mutation, then enter Changesets pre mode with beta and run the normal version workflow. It should commit .changeset/pre.json with the release prep, preserve lockfile synchronization, publish only through the GitHub Release workflow, and verify the beta npm dist-tag.",
  "files": []
},
{
  "id": 7,
  "prompt": "we are on 1.12.0-beta.0 in Changesets pre mode and have a new patch changeset; release the next beta",
  "expected_output": "The assistant should require active .changeset/pre.json for the same beta release line, use changeset status to identify 1.12.0-beta.1, confirm that target before mutation, and run changeset version without entering pre mode again. It should keep .changeset/pre.json for later betas or pre exit, preserve lockfile synchronization, and publish only through the GitHub Release workflow under the beta dist-tag.",
  "files": []
}
```

- [ ] **Step 6: Run direct verification**

Run Step 1 again.
Expected: `PASS: prerelease SemVer workflow is complete`.

Then run:

```bash
node -e '
const e = require("./.agents/skills/npm-release-via-github-actions/evals/evals.json");
if (e.skill_name !== "npm-release-via-github-actions") process.exit(1);
if (e.evals.map((x) => x.id).join(",") !== "1,2,3,4,5,6,7") process.exit(1);
console.log("PASS: valid JSON and eval ids 1-7");
'
rg -n 'CalVer|YYYYMM|1\.20[0-9]{4}\.' .agents/skills/changeset-changelog .agents/skills/npm-release-via-github-actions
git diff --check
git status --short
```

Expected: JSON PASS; stale-policy search has no matches and exits 1; no whitespace errors; only the two Task 2 files modified.

- [ ] **Step 7: Run the standard gate and commit**

Stage the two files, run `npm run verify:staged`, then commit:

```bash
git add .agents/skills/npm-release-via-github-actions/SKILL.md .agents/skills/npm-release-via-github-actions/evals/evals.json
npm run verify:staged
git commit -m "docs(skills): preserve SemVer prerelease releases"
```

In the report, identify the commit as the resolution for carried F-2 and name the initial-beta and subsequent-beta assertion evidence.
