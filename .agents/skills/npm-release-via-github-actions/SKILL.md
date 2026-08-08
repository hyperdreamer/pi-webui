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
   - Confirm the recommended target with the user before editing version files, committing, tagging, or publishing. Show the current version and where it came from, the recommended target, the tag that will be created, and which pending change drives the bump level.
   - If the user supplies an exact stable version, accept it only when it is valid semver, greater than the current version, absent from npm, and not lower than the minimum stable target implied by the highest pending bump. If a check fails, say which one and ask again rather than adjusting the number yourself.
   - If the user supplies an exact prerelease, require valid semver, a version greater than the current version, and an unpublished npm version. Strip prerelease and build metadata to obtain its base release; that base release, not the prerelease itself, must be at least the minimum stable target implied by pending changesets. For example, `1.12.0-beta.1` is valid for a pending minor target of `1.12.0` even though it correctly sorts below stable `1.12.0`.
   - An exact prerelease on a new major line is an explicit request for that major line. Never infer a major prerelease from pending work.
   - Never infer a `major` bump. If the pending changes look breaking and the user has not asked for a breaking release, raise that during confirmation.
   - If npm already has the confirmed version, stop and ask for a different target. npm rejects republishing an existing version.
   - Tag names follow the existing convention in this repository, `v<version>`.

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

5. **Generate changelog and version files**
   - Run the Changesets version step after the user has confirmed the target:
     ```bash
     npm run release:version
     ```
   - This consumes pending `.changeset/*.md` fragments, updates `CHANGELOG.md`, updates `package.json`, and updates the npm lockfile when applicable.
   - Changesets derives the version from the pending fragments and active prerelease state, so its result should already equal the confirmed target (the stable version, or the prerelease version from pre mode). Compare the two. Only if the user requested an exact version that differs from the Changesets result, enforce it with:
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
   - Use the pushed commit on `main` as the target:
     ```bash
     gh release create v<new-version> \
       --target main \
       --title "v<new-version>" \
       --notes-file /tmp/pi-webui-release-notes-v<new-version>.md
     ```
   - If a clean notes file is not practical, `--generate-notes` is acceptable, but prefer the Changesets-generated text because it is curated.
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
   - After the workflow succeeds, verify:
     ```bash
     npm view <package-name> version
     npm view <package-name>@<new-version> dist.tarball
     ```
   - If npm has not updated yet, wait briefly and check again.

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
