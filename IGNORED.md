# Security audit exception policy and register

This file is the canonical PI WEBUI policy and register for narrowly scoped
upstream-only, non-bundled dependency-audit exceptions. Its name does **not**
mean that vulnerabilities are ignored: every registered finding remains tracked,
revalidated, and subject to expiry.

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

## Registered exception: Pi Coding Agent shrinkwrap

| Field | Value |
| --- | --- |
| Status | **Resolved by upstream release** — register kept for audit history |
| Last validated | 2026-08-08 |
| Expires | 2026-08-25 (review anchor; the exception no longer applies) |
| Upstream package path | `@earendil-works/pi-coding-agent@0.84.1` → published `npm-shrinkwrap.json` |
| PI WEBUI compatibility range | `>=0.84.0 <0.85` |
| Bundling evidence | The package `files` allowlist excludes this register and all `node_modules`; verify with `npm pack --dry-run --ignore-scripts --json` at each release. |
| Production-audit requirement | `npm audit --omit=dev --json` must remain clean. |

At the last validation, the newest published Pi Coding Agent release (`0.84.1`)
shrinkwraps `brace-expansion@5.0.9` and `undici@8.9.0`, resolving the registered
`brace-expansion@5.0.7` finding (GHSA-mh99-v99m-4gvg) and the later `undici`
advisories; `npm audit` reports no findings through the Pi package set. Per
policy, a compatible upstream release that resolves the registered findings ends
this exception: future releases require a clean full audit instead.

Remaining findings in the root development installation are pi-webui-own paths
outside this register's upstream-only scope and were never covered by it:
`brace-expansion@5.0.8` via the eslint toolchain (`minimatch@10.2.5`),
`fast-uri@4.1.1` via `fastify`, `js-yaml@4.3.0` via the Changesets toolchain,
and `nanoid@3.3.16` via `postcss`. They must be resolved or handled through the
normal audit gate before release.
