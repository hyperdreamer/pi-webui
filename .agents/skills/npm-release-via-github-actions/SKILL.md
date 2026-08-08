---
name: npm-release-via-github-actions
description: Use this skill whenever the user asks for a new npm version, npm release, package release, new release, version bump, publishing to npm, cutting a GitHub release, tagging a release, or anything similar. It publishes through GitHub Actions and GitHub Releases, not from the local machine, and uses Changesets to generate CHANGELOG.md/release notes. Trigger even for casual phrasing like "ship a release", "bump npm", "publish the package", or "make a new version".
---

# Publish npm packages via GitHub Actions

The user explicitly does **not** want local npm publishing. For release requests, route publishing through the repository's GitHub Actions workflow, usually triggered by a published GitHub Release.

This project also uses Changesets for changelog generation. Release prep should consume `.changeset/*.md` fragments into `CHANGELOG.md` before the GitHub Release is created.

## Core rules

Do not publish from the local machine.

Avoid these commands unless the user explicitly overrides this skill for an unusual emergency:

- `npm publish`
- `npm run publish:npm`
- `pnpm publish`, `yarn publish`, or equivalent package-manager publish commands
- any local publish workaround after a GitHub Actions problem

It is OK to run local safety checks and release-prep commands that do not publish, such as:

- `npm run verify`
- `npm run build`
- `npm run pack:dry`
- `npm run changelog:status`
- `npm run release:version`
- `npm version <version> --no-git-tag-version` when an exact custom version needs to be enforced

## First inspect the repository release setup

Before acting, read:

1. `package.json` for package name, current version, scripts, and package manager.
2. `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock` if present, so version bumps keep lockfiles consistent.
3. `.changeset/config.json` and pending `.changeset/*.md` files, if present.
4. `.github/workflows/publish.yml` or similarly named release workflow.

Confirm the workflow publishes on GitHub, preferably from one of these triggers:

```yaml
on:
  release:
    types: [published]
  workflow_dispatch:
```

For the `pi-webui` repository, the expected workflow is `.github/workflows/publish.yml`; it publishes with `npm publish --access public --provenance` from GitHub Actions. Use the GitHub Release path by default.

If there is no GitHub Actions publish workflow, stop and explain that one must be added or fixed. Do not fall back to local `npm publish`.

## Standard release workflow

1. **Check repo state**
   - Run `git status --short --branch`.
   - Ensure you are on the intended branch, usually `main`.
   - If there are unrelated or user-owned uncommitted changes, pause and ask before including, stashing, or working around them.
   - Pull/rebase only when it is safe and the user has not left local work that could be disrupted.

2. **Review pending changesets**
   - Run:
     ```bash
     npm run changelog:status
     ```
   - Inspect `.changeset/*.md` files.
   - If there are no changesets but there are user-visible changes to release, pause and ask whether to add a changeset. Do not create a low-quality release note just to proceed.
   - If changesets exist, make sure their text is user-facing.
   - This repo uses ordinary semver. Use `patch` for backward-compatible fixes and maintenance, `minor` for backward-compatible new features and capabilities, and `major` only for a breaking release the user explicitly requested.
   - If a pending changeset's bump type does not match its actual compatibility impact, do not rewrite it silently. Carry the corrected classification into the version recommendation in step 3, and apply the correction to the fragment only after the user confirms the target.
   - Use `major` only when the user explicitly requests a breaking/major release.
   - If you believe the pending changes introduce a breaking change but the user has not explicitly requested a major release, pause before versioning and ask the user to confirm whether this should be released as a breaking major version or changed to remain non-breaking.

3. **Determine the release version**
   - Read the current version from `package.json`.
   - Determine the highest bump type among pending changesets, ordering `major` above `minor` above `patch`.
   - Apply that bump to the current version to get the recommended target. From `1.11.3`, a highest pending bump of `patch` gives `1.11.4`, `minor` gives `1.12.0`, and `major` gives `2.0.0`.
   - **Full-candidate contract for every package version.** Before confirming every release candidate that can become an npm package version, whether it is recommended/generated or a user-supplied exact target, validate the complete candidate through the same ordered contract:
     1. Require strict valid SemVer.
     2. Reject any build metadata (`+...`) for both stable and prerelease candidates because npm does not preserve it as the package version: `npm version 1.12.0+sha --no-git-tag-version` writes `1.12.0` and `npm version 1.12.0-beta+sha --no-git-tag-version` writes `1.12.0-beta`, so a build-metadata candidate cannot survive the release workflow.
     3. Require npm itself to reproduce the candidate byte-for-byte in a disposable directory. This probe must not mutate the repository:
        ```bash
        requested_version='<candidate-version>'
        current_version="$(node -p "require('./package.json').version")"
        canonical_version="$(
          set -e
          probe_dir="$(mktemp -d)"
          trap 'rm -rf "$probe_dir"' EXIT
          printf '{"name":"version-probe","version":"%s","private":true}\n' "$current_version" > "$probe_dir/package.json"
          cd "$probe_dir"
          npm version "$requested_version" --no-git-tag-version >/dev/null
          node -p "require('./package.json').version"
        )"
        if [ "$canonical_version" != "$requested_version" ]; then
          echo "npm canonicalized $requested_version to $canonical_version; choose a new release candidate" >&2
          exit 1
        fi
        ```
     If any check fails, explain the failed check and stop before confirmation or repository mutation. For a user-supplied exact target, ask for a new exact target; for a generated prerelease, ask for a safe replacement tag or target and reconstruct the complete candidate. Run the full-candidate contract again before confirming the replacement. Never silently confirm npm's canonicalized replacement.
   - Then apply the checks for the candidate's class:
     - Stable candidate: greater than the current version, absent from npm, and not lower than the minimum stable target implied by the highest pending bump. If a check fails, say which one and ask again rather than adjusting the number yourself.
     - Prerelease candidate: greater than the current version and unpublished on npm. Strip its prerelease portion to obtain its base release; that base release, not the prerelease itself, must be at least the minimum stable target implied by pending changesets. For example, `1.12.0-beta.1` is valid for a pending minor target of `1.12.0` even though it correctly sorts below stable `1.12.0`.
   - **Channel guard for every prerelease path.** After the complete prerelease candidate passes the full-candidate contract and before confirming it or entering/versioning pre mode, derive the channel exactly as `.github/workflows/publish.yml` does: take everything after the first `-`, then everything before the first `.`. Reject channel `latest`, any channel that npm's SemVer parser treats as a valid SemVer range such as numeric `0`, and any channel beginning with `-` (a leading hyphen): npm rejects valid ranges as dist-tags, a prerelease must never move the default `latest` channel, and Changesets parses a leading-hyphen tag as a CLI option, so `changeset -- pre enter --help` prints usage and exits 0 without creating `.changeset/pre.json` while `pre enter -x` fails with an unknown-flag error. Run this recipe:
     ```bash
     requested_version='<candidate-version>'
     tag="${requested_version#*-}"
     tag="${tag%%.*}"
     node -e 'const semver = require("semver"); const tag = process.argv[1]; if (tag.startsWith("-") || tag === "latest" || semver.validRange(tag) !== null) { console.error("invalid npm dist-tag:", tag, "must not start with `-`, must not be `latest`, and must not be a valid SemVer range"); process.exit(1); }' "$tag"
     ```
     The full-candidate contract and then this guard apply to every prerelease entry path: a user-supplied exact prerelease, the default or recommended first prerelease, a user-named initial prerelease tag, and Changesets output for a subsequent prerelease in active pre mode. A failure must stop before `changeset pre enter`, `changeset version`, version-file edits, commit, tag, or release creation; ask for a safe named channel and target, rerun both validations, and reconfirm before proceeding.
   - **Release target vs. Changesets intermediate.** Distinguish the version that will actually be released from the version Changesets is expected to emit:
     - **Release target:** the single version shown to the user for confirmation and ultimately tagged and published.
     - **Changesets intermediate candidate:** the valid version Changesets is expected to emit before an allowed exact-version override. Validate it through the same contract as the target, but never present it as a second release target and never confirm it merely because it passed validation.
     - **Generated-target flow:** the intermediate and the release target are the same version; confirm it once.
     - **Exact-target flow:** the user's exact version is the release target; the Changesets-derived version is only the validated intermediate that may be overridden after versioning; confirm only the exact target once.
     - **Final stable from pre mode:** the active prerelease base is the release target; the stable Changesets result is the intermediate; confirm the base once.

     | Flow | Release target | Changesets intermediate | Confirmation |
     | --- | --- | --- | --- |
     | generated stable/prerelease | generated candidate | same version | generated target once |
     | exact stable/prerelease | user exact version | Changesets-derived version | exact target once |
     | final stable from pre mode | active prerelease base | stable Changesets result | stable base once |
   - **Confirmation comes after validation.** The release target is the sole version confirmed per release attempt; confirmation happens exactly once, after every applicable target, intermediate, class, channel, and pre-mode consistency check has passed and before mutation. After the full-candidate contract, the candidate-class checks, and the prerelease channel guard where applicable have passed, confirm the validated release target with the user before editing version files, entering/versioning pre mode, committing, tagging, or publishing. Show the current version and where it came from, the recommended or user-selected target, the tag that will be created, and which pending change drives the bump level.
   - An exact prerelease on a new major line is an explicit request for that major line. Never infer a major prerelease from pending work.
   - Never infer a `major` bump. If the pending changes look breaking and the user has not asked for a breaking release, raise that during confirmation.
   - If npm already has the confirmed version, stop and ask for a different target. npm rejects republishing an existing version.
   - Tag names follow the existing convention in this repository, `v<version>`.

4. **Prepare Changesets prerelease mode when requested**
   - Stable releases outside an active prerelease line skip this step.
   - **Initial prerelease on a release line.** Derive the stable base target from pending changesets. Determine the prerelease channel: if the user supplied an exact prerelease, derive the channel from that exact target (everything after the first `-`, then everything before the first `.`); if the user separately named a channel that disagrees with the exact target's channel, stop and ask the user to resolve the conflict before confirmation. If there is no exact prerelease and the user did not name a tag, use `beta`, matching this repository's established tags. Before mutation, predict the Changesets intermediate as `<base>-<tag>.0` and validate both the release target and that intermediate through the step 3 full-candidate contract, the candidate-class checks where applicable, and the step 3 channel guard. The exact target must remain greater than the current version, unpublished, and no lower in base compatibility than pending work.
   - **Generated-target flow (initial).** The predicted intermediate `<base>-<tag>.0` is also the release target; confirm it exactly once, then enter pre mode:
     ```bash
     npm run changeset -- pre enter <tag>
     ```
     `changeset -- pre enter <tag>` creates `.changeset/pre.json` immediately. Immediately after a valid `pre enter`, verify that `.changeset/pre.json` exists with the expected tag and `"mode": "pre"` before any versioning:
     ```bash
     expected_tag='<tag>'
     node -e 'const fs=require("node:fs"); const expected=process.argv[1]; const path=".changeset/pre.json"; if (!fs.existsSync(path)) { console.error("Changesets pre mode was not created"); process.exit(1); } const pre=JSON.parse(fs.readFileSync(path,"utf8")); if (pre.mode!=="pre" || pre.tag!==expected) { console.error("unexpected Changesets pre state:", pre.mode, pre.tag, "expected pre", expected); process.exit(1); }' "$expected_tag"
     ```
     If the postcondition fails, stop and resolve or revert the failed pre-mode preparation before any `changeset version`, package/changelog edit, commit, tag, or release creation. The following `changeset version` step updates its consumed-changeset state; commit the resulting `.changeset/pre.json` with the release prep.
   - **Exact-target flow (initial).** The exact ordinal remains the sole confirmed release target; validate it through the same contract and confirm only it exactly once, explaining that Changesets may emit the validated intermediate before the documented step 5 override. Never recommend or confirm `<base>-<tag>.0` after an exact ordinal has been selected as the release target. Enter pre mode only after that sole confirmation, run the same `pre enter` and `pre.json` postcondition as above, then run Changesets versioning normally and apply the step 5 exact override and changelog-heading correction only if the actual Changesets result differs from the exact target.
   - **Subsequent prerelease in active pre mode.** Require `.changeset/pre.json` with `"mode": "pre"`, the same tag, and the same release base; an exact target must have the same base and channel as the active pre mode, otherwise stop before confirmation. Run `npm run changelog:status`; treat its next prerelease version as the Changesets intermediate candidate. Validate the intermediate and the selected release target through the step 3 full-candidate contract and channel guard. Generated-target flow: the status result is the release target; confirm it exactly once. Exact-target flow: the user's exact ordinal is the release target; confirm only it exactly once, and treat the status result only as the validated intermediate to be overridden after versioning when different. Run `changeset version` without entering pre mode again. Keep `.changeset/pre.json` coherent for later prereleases and final stable exit.
   - If the package version is already a prerelease but `.changeset/pre.json` is absent, exited, or names a different tag/base, stop and explain the inconsistent prerelease state instead of guessing or recreating it.
   - For the final stable release from pre mode, confirm the current prerelease's base version before mutation, then exit pre mode:
     ```bash
     npm run changeset -- pre exit
     ```
     Run the normal version step next; it must write the stable base version and remove `.changeset/pre.json`.
   - `.github/workflows/publish.yml` derives the npm dist-tag from the first prerelease identifier, so `1.12.0-beta.1` publishes under `beta` while stable versions publish under `latest`.

5. **Generate changelog and version files**
   - Run the Changesets version step after the user has confirmed the target:
     ```bash
     npm run release:version
     ```
   - This consumes pending `.changeset/*.md` fragments, updates `CHANGELOG.md`, updates `package.json`, and updates the npm lockfile when applicable.
   - Changesets derives the version from the pending fragments and active prerelease state. In a generated-target flow that result is the release target itself; in an exact-target flow it is the validated Changesets intermediate, which is allowed to differ only when the user requested an exact version. Compare the result with the confirmed release target. Only if the user requested an exact version that differs from the Changesets result (the validated intermediate), enforce it with:
     ```bash
     npm version <confirmed-version> --no-git-tag-version
     ```
   - If you enforced a different version in the previous bullet, update the newly generated `CHANGELOG.md` heading to match it. This manual changelog heading edit is acceptable during release prep; normal development should still use changeset fragments instead.
   - If the Changesets result and the confirmed stable or prerelease target disagree for any other reason, stop and reconcile it with the user rather than overwriting the version silently.
   - Review the generated `CHANGELOG.md` section. It should be suitable for GitHub Release notes.
   - Do not use plain `npm version <new-version>` because it creates a local git tag as a side effect; releases should be controlled via GitHub.
   - **Sync the lockfile to the final version.** `npm run release:version` (Changesets) updates `package.json` but does not reliably rewrite `package-lock.json`, and the exact-version-enforcing `npm version --no-git-tag-version` only touches the lock when it actually runs. Either path can leave the committed `package-lock.json` behind at the previous version, which then resurfaces as an unexpected diff after the next `npm install`. After the version is finalized, always resync the lockfile without touching `node_modules`:
     ```bash
     npm install --package-lock-only
     ```
   - Confirm the lockfile now matches `package.json` before continuing:
     ```bash
     node -e "const v=require('./package.json').version, l=require('./package-lock.json'); if (l.version!==v || l.packages[''].version!==v) { console.error('lockfile version mismatch:', l.version, l.packages[''].version, 'expected', v); process.exit(1); } console.log('lockfile in sync at', v);"
     ```
   - If the lockfile mismatch persists, stop and resolve it before committing; do not ship a release whose `package-lock.json` version disagrees with `package.json`.

6. **Run checks before creating the release**
   - Run the repository's normal verification commands, for example:
     ```bash
     npm run verify
     npm run build
     npm run pack:dry
     ```
   - If checks fail, fix the issue or report it. Do not create the GitHub Release until the release commit is sound.

7. **Commit and push the release prep**
   - Commit only intended release changes. Typical files include:
     - `package.json`
     - `package-lock.json`
     - `CHANGELOG.md`
     - consumed/deleted `.changeset/*.md` fragments
   - Before staging, confirm `package-lock.json` is actually in the diff and carries the new version. If `git status --short` does not show `package-lock.json` as modified while `package.json` changed version, the lockfile sync in step 5 was missed — go back and run `npm install --package-lock-only`. Never commit a release where `package.json` advanced but `package-lock.json` did not.
   - Use:
     ```bash
     git add package.json package-lock.json CHANGELOG.md .changeset
     git commit -m "chore(release): v<new-version>"
     git push origin main
     ```
   - If there are other intentional changes required for the release, include them deliberately and mention them.

8. **Create a GitHub Release to trigger publishing**
   - Prefer release notes from the generated changelog instead of generic generated notes.
   - Extract the new version's section from `CHANGELOG.md` into a temporary notes file if useful.
   - Use the pushed commit on `main` as the target. For a stable version, keep the release unmarked as a prerelease:
     ```bash
     gh release create v<new-version> \
       --target main \
       --title "v<new-version>" \
       --notes-file /tmp/pi-webui-release-notes-v<new-version>.md
     ```
   - For a prerelease version, use the same target, title, and notes, and explicitly prevent GitHub from treating it as the latest stable release:
     ```bash
     gh release create v<new-version> \
       --target main \
       --title "v<new-version>" \
       --notes-file /tmp/pi-webui-release-notes-v<new-version>.md \
       --prerelease --latest=false
     ```
   - If a clean notes file is not practical, `--generate-notes` is acceptable, but prefer the Changesets-generated text because it is curated. Preserve the corresponding stable or prerelease metadata branch when changing only the notes option.
   - Creating a non-draft published release triggers `on: release: types: [published]`.
   - If the user specifically wants to review notes first, create a draft release, then publish it through GitHub when approved. Remember: draft creation will not trigger publishing until it is published.

9. **Monitor GitHub Actions**
   - Find the publish run:
     ```bash
     gh run list --workflow publish.yml --limit 5
     ```
   - Watch it:
     ```bash
     gh run watch <run-id>
     ```
   - If it fails, inspect logs:
     ```bash
     gh run view <run-id> --log-failed
     ```
   - Fix by committing and creating a new release/tag if needed, or rerun the failed GitHub Actions job when the failure is transient. Do not publish locally as a workaround.

10. **Verify npm registry publication**
   - After the workflow succeeds, keep the exact-version tarball check so verification cannot accidentally resolve a different tag or version:
     ```bash
     npm view <package-name>@<new-version> dist.tarball
     ```
   - Then assert the workflow updated the expected dist-tag to the exact new version. Stable releases must check `latest`. Prereleases must derive the tag with the same first-prerelease-identifier operations as `.github/workflows/publish.yml`:
     ```bash
     new_version='<new-version>'
     if [[ "$new_version" == *-* ]]; then
       tag="${new_version#*-}"
       tag="${tag%%.*}"
     else
       tag='latest'
     fi
     published_version="$(npm view <package-name> "dist-tags.$tag")"
     if [ "$published_version" != "$new_version" ]; then
       echo "npm dist-tags.$tag is $published_version, expected $new_version" >&2
       exit 1
     fi
     ```
     This is the required `npm view <package-name> dist-tags.latest` equality assertion for stable releases and `npm view <package-name> dist-tags.<tag>` equality assertion for prereleases.
   - If npm has not updated yet, wait briefly and check both the exact-version tarball and expected dist-tag again. A successful workflow is not sufficient while either registry assertion disagrees.

## Reruns and special cases

- If a GitHub Actions publish run failed due to a transient infrastructure issue, prefer `gh run rerun <run-id> --failed` or rerun the workflow in GitHub.
- If using `workflow_dispatch`, pass the intended ref/tag explicitly where possible:
  ```bash
  gh workflow run publish.yml --ref v<version>
  ```
  Use this mainly for reruns or repositories designed around manual dispatch. For normal releases, prefer a published GitHub Release.
- If the npm version already exists, npm will reject publishing. Bump to a new version and create a new release; do not try to overwrite an existing npm version.
- If a GitHub Release/tag was created incorrectly, fix it on GitHub with care and tell the user exactly what changed.
- Never use local `npm publish` as a workaround for a GitHub Actions or npm provenance issue.

## Final response format

After completing or attempting a release, summarize concisely:

- Version requested/released
- Changelog source: generated `CHANGELOG.md` section or other notes used
- Commit hash and pushed branch
- GitHub Release URL
- GitHub Actions run URL and status
- npm verification result, if published
- Any follow-up needed from the user
