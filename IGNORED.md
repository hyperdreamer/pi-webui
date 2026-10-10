# Security audit exception policy and register

This file is the canonical PI WEBUI policy and register for narrowly scoped
dependency-audit exceptions. It registers two distinct exception classes: an
upstream-only, non-bundled exception for published upstream package paths, and
a dev-only, no-upstream-patch exception for PI WEBUI's own development
tooling. Its name does **not** mean that vulnerabilities are ignored: every
registered finding remains tracked, revalidated, and subject to expiry.

## Policy

A Security Auditor may classify a security gate as **pass with documented
exception** only when every condition below is true and the Project Manager
records the approval and evidence in the release handoff:

1. `npm audit --omit=dev --json` exits successfully with no production
   vulnerabilities.
2. `npm audit --include=dev --json` reports only the exact registered findings
   and advisory IDs below; no additional findings are accepted by this policy.
3. The finding appears in PI WEBUI's audited tree through the root development
   installation, and the affected dependency is not bundled in the PI WEBUI npm
   tarball. Verify this with `npm pack --dry-run --ignore-scripts --json`. This
   does not classify the upstream peer's runtime dependencies as safe.
4. The path is locked by a third-party published `npm-shrinkwrap.json`; PI WEBUI
   did not introduce or alter the affected dependency declaration or resolution.
   Ordinary release-version metadata changes do not count as altering that path.
5. The Security Auditor verifies that no compatible upstream Pi package set
   resolves every registered advisory, and records the versions checked.
6. The release candidate contains no secrets, application SAST findings, or
   other dependency vulnerabilities. This exception is never a substitute for
   those checks.
7. The registered exception is within its stated expiry date. An expired entry
   fails the security gate until a new documented policy review renews it.
8. The auditor records the commands, results, package provenance, review date,
   and expiry in the release handoff. The PM explicitly approves the exception
   before QA may begin.

This exception is limited to PI WEBUI's release gate. It does not claim that the
upstream Pi package is safe at runtime, waive Pi's own security obligations, or
permit changing an upstream shrinkwrap, manually editing its locked dependency
versions, using `npm audit fix --force`, or suppressing audit output.

The exception expires on the date listed below, must be revalidated for every
release, and may be renewed only through a new documented policy review. A
compatible upstream release that resolves the findings ends this exception:
upgrade the Pi package set together and require a clean full audit instead.

## Dev-only, no-upstream-patch exception policy

This is a separate exception class added by PM-approved policy review on
2026-10-10. It applies only to the enumerated findings under the register
below, never to production dependencies, and it does not widen the
upstream-only exception above.

A Security Auditor may classify the release gate as **pass with documented
dev-only exception** only when every condition below is true and the Project
Manager records the approval and evidence in the release handoff:

1. `npm audit --omit=dev --json` exits successfully with no production
   vulnerabilities.
2. `npm audit --include=dev --json` reports only the exact findings registered
   below; no additional findings are accepted.
3. Each registered finding reaches the tree only through `devDependencies`, is
   absent from the production tree (`npm ls <package> --omit=dev` is empty),
   and is absent from the published artifact (`npm pack --dry-run
   --ignore-scripts --json` contains no `node_modules` and no register paths).
4. The affected advisory has no published patched release: every published
   version is inside the vulnerable range at validation time, and the latest
   published version of each affected package and of every parent in the
   dependency path is recorded.
5. No non-breaking remedy exists: record the non-forced `npm audit fix`
   result, the parents' declared ranges, and why an in-range update cannot
   remove the finding. Never use `npm audit fix --force`, an override outside
   a declared range, or a downgrade as a remedy.
6. The finding is denial-of-service-only with no code execution, data
   exposure, or credential impact, and it is reachable only under
   maintainer-run build or release tooling, not from attacker-controlled
   runtime input in a deployed PI WEBUI or published package.
7. The release candidate contains no secrets, application SAST findings, or
   other dependency vulnerabilities beyond conditions 1–6.
8. The registered exception is within its stated expiry date, is revalidated
   for every release, and ends immediately when a patched release, a parent
   release that removes the path, or an equivalent upstream change makes the
   finding removable. Renewal requires a new documented policy review;
   applying the available fix and deleting the entry is preferred.
9. The auditor records the commands, results, package provenance, review
   date, and expiry in the release handoff, and the PM explicitly approves
   the exception before the GitHub Release is created.

## Registered exception: Pi Coding Agent shrinkwrap

| Field | Value |
| --- | --- |
| Status | **Resolved by upstream release** — register kept for audit history |
| Last validated | 2026-08-08 |
| Expires | 2026-08-25 (review anchor; the exception no longer applies) |
| Upstream package path | `@earendil-works/pi-coding-agent@0.84.1` → published `npm-shrinkwrap.json` |
| PI WEBUI compatibility range | `>=0.87.0 <0.88` |
| Bundling evidence | The package `files` allowlist excludes this register and all `node_modules`; verify with `npm pack --dry-run --ignore-scripts --json` at each release. |
| Production-audit requirement | `npm audit --omit=dev --json` must remain clean. |

At the last validation, the newest published Pi Coding Agent release (`0.84.1`)
shrinkwraps `brace-expansion@5.0.9` and `undici@8.9.0`, resolving the registered
`brace-expansion@5.0.7` finding (GHSA-mh99-v99m-4gvg) and the later `undici`
advisories; `npm audit` reports no findings through the Pi package set. Per
policy, a compatible upstream release that resolves the registered findings ends
this exception; from that point the production audit must stay clean, and any
residual dev-only finding must be registered under the dev-only exception
policy below.

Remaining findings in the root development installation are pi-webui-own paths
outside this register's upstream-only scope and were never covered by it. The
findings recorded here at the last validation were remediated in `dbb393e` and
released in v1.18.8. Current dev-tree residuals are registered in the dev-only
section below and must satisfy that policy before release.

## Registered exception: dev-only advisories with no upstream patch

| Field | Value |
| --- | --- |
| Status | **Active** — dev-only, non-bundled, no published patch |
| Registered | 2026-10-10 |
| PM approval | 2026-10-10, for release v1.23.0 |
| Expires | 2026-11-09 (revalidate at every release; renewal requires a policy review) |
| Affected packages | `braces@3.0.3`, `sprintf-js@1.0.3` (development tree only) |
| Evidence | `.superpowers/evidence/release-1.23.0-security/` (gitignored) |

- **`braces@3.0.3`** — GHSA-vfj7-8cjw-p6xm (high, stack-exhaustion DoS),
  vulnerable range `<=3.0.3`. The latest published release is `3.0.3`
  (checked 2026-10-10), so no patched version exists. Reached only through
  `@changesets/cli@2.31.1` -> (`@changesets/config@3.1.4` /
  `@changesets/git@3.0.4`) -> `micromatch@4.0.8` -> `braces`, and
  `vite-plugin-static-copy@4.1.1` -> `chokidar@3.6.0` -> `braces`.
  `micromatch@latest` (4.0.8) still declares `braces: ^3.0.3`, and
  `vite-plugin-static-copy@latest` (4.1.1) still declares `chokidar: ^3.6.0`,
  while `chokidar` 4/5 no longer depend on `braces`. No in-range update
  removes it.
- **`sprintf-js@1.0.3`** — GHSA-hp3w-g68c-fv3c (moderate, unbounded-precision
  DoS), vulnerable range `<=1.1.3`. The latest published release is `1.1.3`
  (checked 2026-10-10), so no patched version exists. Reached only through
  `@changesets/cli@2.31.1` -> `@manypkg/get-packages@1.1.3` ->
  `read-yaml-file@1.1.0` -> `js-yaml@3.15.2` -> `argparse@1.0.10` ->
  `sprintf-js`. `@changesets/cli` declares `@manypkg/get-packages: ^1.1.3`,
  whose latest 1.x release (`1.1.3`) still carries the path;
  `@manypkg/get-packages` 3.x drops `read-yaml-file`, but moving there is a
  breaking parent change, not an in-range update.

Validation for release v1.23.0 (2026-10-10): non-forced `npm audit fix`
remediated every addressable finding (`fastify` 5.12.3 -> 5.12.5 and
`fast-uri` 3.1.7 -> 3.1.8 / 4.1.4 -> 4.2.1 in the production tree;
`smol-toml` 1.8.0 -> 1.9.1, `source-map-js` 1.2.1 -> 1.2.2, and
`@changesets/cli` 2.31.0 -> 2.31.1 in the development tree). After
remediation, `npm audit --omit=dev --json` exits 0 with zero vulnerabilities
and `npm audit --include=dev --json` exits 1 with 21 findings, all
attributable to the two advisories above. `npm ls braces sprintf-js
--omit=dev` is empty, and the `npm pack --dry-run --ignore-scripts` manifest
contains no `node_modules` and no register paths. Both findings are DoS-only
and reachable only through maintainer-run Changesets and Vite build tooling.
