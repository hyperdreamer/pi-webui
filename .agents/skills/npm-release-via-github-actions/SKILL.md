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

2. **Review and normalize pending changesets**
   - Run:
     ```bash
     npm run changelog:status
     ```
   - Inspect `.changeset/*.md` files.
   - If there are no changesets but there are user-visible changes to release, pause and ask whether to add a changeset. Do not create a low-quality release note just to proceed.
   - If changesets exist, make sure their text is user-facing.
   - For `pi-webui`, non-breaking changesets must use `patch` even for new features. The package uses CalVer shaped as semver: `MAJOR.YYYYMM.PATCH`. The semver `minor` position is the release month, not feature size.
   - If a pending changeset uses `minor` for a non-breaking change, edit its frontmatter to `patch` before versioning. Do not ask the user whether to use a patch increase or date change.
   - Use `major` only when the user explicitly requests a breaking/major release.
   - If you believe the pending changes introduce a breaking change but the user has not explicitly requested a major release, pause before versioning and ask the user to confirm whether this should be released as a breaking major version or changed to remain non-breaking.

3. **Compute the `pi-webui` CalVer version**
   - For `pi-webui`, always compute the version from the release date as `MAJOR.YYYYMM.PATCH`.
   - Use the current date at release time for `YYYYMM` (for example, `date +%Y%m`). Do not ask whether to use a same-month patch increase or a date change.
   - Keep the current `MAJOR` unless the user explicitly requests a breaking/major release. Do not infer or perform a major version bump on your own.
   - Set `PATCH` deterministically:
     - If the current package version already has the target `MAJOR` and release-month `YYYYMM`, use current patch + 1.
     - Otherwise use patch `0` for the first release of that major/month.
     - If npm already has the computed version, increment only `PATCH` until an unpublished version is found.
   - If the user says `patch`, `minor`, `new version`, `new release`, `publish`, or similar without an exact version, still use this CalVer algorithm. Treat `minor` as a non-breaking release request, not as permission to let Changesets increment semver minor arbitrarily.
   - If the user gives an exact version, use it only when they clearly intend that exact value. Otherwise preserve the CalVer rule above.
   - If the computed CalVer target would be lower than or equal to the current package version because of clock/version inconsistency, stop and explain the inconsistency instead of inventing a non-CalVer version.

4. **Generate changelog and version files**
   - Run the Changesets version step after normalizing non-breaking changesets to `patch`:
     ```bash
     npm run release:version
     ```
   - This consumes pending `.changeset/*.md` fragments, updates `CHANGELOG.md`, updates `package.json`, and updates the npm lockfile when applicable.
   - Changesets may produce a semver bump that does not match the computed CalVer target, especially on the first release of a new month. That is expected; enforce the computed target with:
     ```bash
     npm version <computed-calver-version> --no-git-tag-version
     ```
   - Update the newly generated `CHANGELOG.md` heading to match the computed CalVer version if Changesets used a different heading. This manual changelog heading edit is acceptable during release prep; normal development should still use changeset fragments instead.
   - Review the generated `CHANGELOG.md` section. It should be suitable for GitHub Release notes.
   - Do not use plain `npm version <new-version>` because it creates a local git tag as a side effect; releases should be controlled via GitHub.
   - **Sync the lockfile to the final version.** `npm run release:version` (Changesets) updates `package.json` but does not reliably rewrite `package-lock.json`, and the CalVer-enforcing `npm version --no-git-tag-version` only touches the lock when it actually runs. Either path can leave the committed `package-lock.json` behind at the previous version, which then resurfaces as an unexpected diff after the next `npm install`. After the version is finalized, always resync the lockfile without touching `node_modules`:
     ```bash
     npm install --package-lock-only
     ```
   - Confirm the lockfile now matches `package.json` before continuing:
     ```bash
     node -e "const v=require('./package.json').version, l=require('./package-lock.json'); if (l.version!==v || l.packages[''].version!==v) { console.error('lockfile version mismatch:', l.version, l.packages[''].version, 'expected', v); process.exit(1); } console.log('lockfile in sync at', v);"
     ```
   - If the lockfile mismatch persists, stop and resolve it before committing; do not ship a release whose `package-lock.json` version disagrees with `package.json`.

5. **Run checks before creating the release**
   - Run the repository's normal verification commands, for example:
     ```bash
     npm run verify
     npm run build
     npm run pack:dry
     ```
   - If checks fail, fix the issue or report it. Do not create the GitHub Release until the release commit is sound.

6. **Commit and push the release prep**
   - Commit only intended release changes. Typical files include:
     - `package.json`
     - `package-lock.json`
     - `CHANGELOG.md`
     - consumed/deleted `.changeset/*.md` fragments
   - Before staging, confirm `package-lock.json` is actually in the diff and carries the new version. If `git status --short` does not show `package-lock.json` as modified while `package.json` changed version, the lockfile sync in step 4 was missed — go back and run `npm install --package-lock-only`. Never commit a release where `package.json` advanced but `package-lock.json` did not.
   - Use:
     ```bash
     git add package.json package-lock.json CHANGELOG.md .changeset
     git commit -m "chore(release): v<new-version>"
     git push origin main
     ```
   - If there are other intentional changes required for the release, include them deliberately and mention them.

7. **Create a GitHub Release to trigger publishing**
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

8. **Monitor GitHub Actions**
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

9. **Verify npm registry publication**
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
