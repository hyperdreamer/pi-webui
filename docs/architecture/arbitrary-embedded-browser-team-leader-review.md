# Team Leader review: fail-closed browser foundation

## Review record

| Field | Value |
| --- | --- |
| Active phase | Team Leader / Code Review |
| Base architecture commit | `85840ca918ee37869ac3793b302b81ee5ac70b84` — `docs(architecture): design arbitrary-site browser service` |
| Review target | `16780cd1a6de5598cca422bde7f3c504c62cb338` — `feat(browser): add fail-closed remote browser foundation` |
| Branch/worktree reviewed | `agent/browser-connection-fix` at `/data/home/guest/Development/pi-webui-browser-connection-fix` |
| Review-fix iteration | 1 of 3 |

### Reviewed files

The full target-vs-base diff was reviewed. Changed files:

- `.changeset/fail-closed-browser-foundation.md`
- `docs/faq.html`
- `src/client/src/components/BrowserPanel.ts`
- `src/client/src/components/BrowserPanel.test.ts`
- `src/server/app.ts`
- `src/server/app.browserCapabilities.test.ts`
- `src/server/browser/browserRuntime.ts`
- `src/server/browser/browserCapabilities.ts`
- `src/server/browser/browserCapabilities.test.ts`
- `src/server/browser/browserCapabilityRoutes.ts`
- `src/server/browser/browserCapabilityRoutes.test.ts`
- `src/server/browser/browserPolicy.ts`
- `src/server/browser/browserPolicy.test.ts`

Architecture and boundary/context files also inspected:

- `docs/architecture/arbitrary-embedded-browser.md`
- `src/server/index.ts`, `src/server/sessiond.ts`, and `src/server/configRoutes.ts`
- `src/server/machines/machineProxyRoutes.ts`, `machineClient.ts`, `machineRoutes.ts`, and `machineService.ts`
- `src/shared/federatedRoutes.ts` and `src/shared/capabilities.ts`
- `package.json`, `vitest.config.ts`, and `eslint.config.js`

## Findings

### Blocker

- None. The shipped entrypoint does not inject a browser runtime or trusted browser-principal provider, so this target does not start Chromium, expose a browser control endpoint, or create an immediately exploitable browser egress path.

### Major

1. **M1 — IPv6 transition forms can hide a private IPv4 destination from the public-address policy.**
   **Locations:** `src/server/browser/browserPolicy.ts:236-245,290-301`; missing regression cases in `src/server/browser/browserPolicy.test.ts:103-127`.

   `isPublicIpv6()` only treats IPv4-compatible and IPv4-mapped (`::ffff:0:0/96`) addresses as embedded IPv4 when the high bits equal `0` or `0xffff`. It therefore classifies `64:ff9b::c0a8:1` (the well-known NAT64 form of `192.168.0.1`) and `::ffff:0:c0a8:1` as public. The former is not covered by the prefix list, which only blocks the locally assigned `64:ff9b:1::/48` prefix. A runtime or network that translates either form can reach a private IPv4 service even though this layer reports a public destination.

   Independent reproduction returned `true` for both addresses, and `evaluateBrowserNavigation()` allowed both literal HTTPS URLs in `public-web` mode. This conflicts with the architecture's public-address-only egress requirement. Reject IPv4-embedded transition forms that encode non-public IPv4, conservatively reject unsupported translation prefixes, and add IPv4/IPv6 transition, NAT64, and private-metadata regression fixtures before any runtime can rely on this classifier.

2. **M2 — The test's claimed 404 behavior is false in the application configuration that serves the client.**
   **Locations:** `src/server/browser/browserCapabilityRoutes.test.ts:75-82`; interaction with `src/server/app.ts:261-265`.

   The route unit test uses a bare Fastify instance and asserts that unregistered browser controls and remote capability discovery return 404. In the normal `buildApp()` path, however, the SPA `setNotFoundHandler()` returns `index.html` for those unmatched API URLs. Independent injection against the default app returned HTTP 200 with `text/html` for all of:

   - `GET /api/machines/remote/browser/capabilities`
   - `POST /api/machines/local/browser/sessions`
   - `GET /api/machines/local/browser/sessions`

   No browser operation occurs, but clients see a successful non-JSON response rather than the required absent-capability/404 contract. This breaks the architecture's rolling-upgrade fallback semantics and produces misleading failure behavior for a future client. Ensure unmatched API/browser paths return a JSON 404 ahead of the SPA fallback (or otherwise explicitly reject this browser route family), and test through `buildApp()` with a client distribution enabled.

### Minor

1. **m1 — A failed principal adapter is presented as absent authentication rather than an unavailable identity dependency.**
   **Location:** `src/server/browser/browserCapabilityRoutes.ts:36-42`.

   Any exception from the injected trusted identity adapter is swallowed and becomes `BROWSER_AUTH_REQUIRED`. This remains fail-closed, but it gives an incorrect, non-retryable diagnosis for a proxy/identity outage and leaves no observable distinction from an unauthenticated request. Preserve the safe response boundary while mapping dependency failure to a retryable unavailable result (and safe server-side diagnostics) so the future UI can provide truthful recovery guidance.

### Nit

- None.

## Security and architecture assessment

### What the target gets right

- The implementation is genuinely unavailable in the shipped server: `src/server/index.ts` calls `buildApp()` without either optional browser dependency, and the default runtime reports unavailable. The current client remains the sandboxed, no-referrer iframe viewer and explicitly says remote mode is unavailable.
- No changed code fetches an arbitrary destination through Fastify, forwards destination content, rewrites framing/security headers, exposes cookies, creates a CDP/control tunnel, launches Chromium, or opens a browser port. The new policy module performs no network fetch.
- Remote browser routes were not added to `FEDERATED_HTTP_ROUTES` or the WebSocket allowlist. The existing machine client continues to filter `cookie` and `authorization` headers. There is therefore no new arbitrary machine proxy or gateway-cookie forwarding path.
- The capability seam is local-only, requires an injected server-side principal, and requires all modeled readiness properties before it can report availability. The default absence of that adapter is appropriately fail-closed.
- No `sessiond` source, protocol, ownership, or lifecycle path changed. The new default runtime adapter is side-effect free, and the target does not alter the split web/API versus session-daemon model.
- The FAQ, panel notice, and Changeset accurately state that the shipped Browser remains a lightweight embedded viewer; no unsupported arbitrary-site browsing, header bypass, or proxy behavior is claimed. The patch Changeset is appropriate for the user-visible clarification and shipped code; `CHANGELOG.md` was not edited.
- No client application-owned URL construction was added. The only existing destination reference remains the user-entered external iframe URL, not a PI WEBUI application path.

### Required conclusion on scope

An intentionally unavailable-by-default foundation is an acceptable bounded implementation of the architecture's staged rollout. It should not be rejected merely because it does not yet implement `browserd`, Chromium, streaming, control routes, remote federation, or a client remote mode: shipping none of those is safer and the user-facing documentation is honest.

This particular target is nevertheless **not eligible to merge**. M1 leaves the new future egress-policy foundation unsafe for an IPv6/NAT64 deployment, and M2 means its absence/failure contract is not true in the normal app hosting mode. Neither issue currently enables remote browsing, but both must be corrected before this security-sensitive foundation becomes a durable base for the next implementation phase.

## Checks run

| Check | Result |
| --- | --- |
| Full `git diff` and all changed source, tests, documentation, and Changeset reviewed against the base and architecture document | Completed |
| `git diff --check 85840ca918ee37869ac3793b302b81ee5ac70b84 16780cd1a6de5598cca422bde7f3c504c62cb338` | Passed; no whitespace errors |
| Focused browser/client tests: `npm test -- --run src/server/browser/browserPolicy.test.ts src/server/browser/browserCapabilities.test.ts src/server/browser/browserCapabilityRoutes.test.ts src/server/app.browserCapabilities.test.ts src/client/src/components/BrowserPanel.test.ts` | Passed: 5 files, 56 tests |
| Full quality gate: `npm run verify` | Passed: typecheck, lint, knip, and Vitest; 268 files passed, 2,024 tests passed, 2 skipped |
| IPv6 policy probe using `isPublicInternetAddress()` and `evaluateBrowserNavigation()` | Failed as expected for M1: `64:ff9b::c0a8:1` and `::ffff:0:c0a8:1` were classified and allowed as public |
| Default `buildApp()` route-injection probe with the client static fallback enabled | Failed as expected for M2: absent browser API paths returned HTTP 200 `text/html` SPA content rather than 404 |
| Diff/path inspection for `sessiond` changes | Passed: no changed `sessiond` or session-daemon protocol path |
| Machine proxy, configured-header filtering, selected-machine config, and federated-route allowlist inspection | Passed for the current scope: no browser route, cookie forwarding, or config-based enablement was introduced |

## Decision and handoff

**Merge status: false**

**Completion status: fail**

**Next permitted action for PM:** return the target to the Programmer for review-fix iteration 1/3, limited to M1, M2, and m1 remediation plus focused regression tests. Do not merge or schedule Security Auditor review until a new stable implementation commit passes Team Leader re-review.

## Re-review — 2026-07-25 (Programmer remediation round 1/3)

### Re-review record

| Field | Value |
| --- | --- |
| Active phase | Team Leader / Code Review — re-review after Programmer remediation round 1/3 |
| Architecture base | `85840ca918ee37869ac3793b302b81ee5ac70b84` — `docs(architecture): design arbitrary-site browser service` |
| Original implementation baseline | `16780cd1a6de5598cca422bde7f3c504c62cb338` — `feat(browser): add fail-closed remote browser foundation` |
| Prior Team Leader review report | `e4cf2a7622de422b5794f9ee9756b5e13a5a9556` — `docs(review): assess fail-closed browser foundation` |
| Remediation target reviewed | `d211d179c3506e60a917cfe166c860cd5d8a610d` — `fix(browser): harden fail-closed capability boundaries` |
| Branch/worktree reviewed | `agent/browser-connection-fix` at `/data/home/guest/Development/pi-webui-browser-connection-fix` |
| Review-fix iteration | 1 of 3 — remediation accepted; no round 2 is required |

### Prior-finding outcomes

#### M1 — IPv6/IPv4-transition address classification

**Outcome: pass — resolved.** `src/server/browser/browserPolicy.ts:239-299` now recognizes IPv4-compatible, IPv4-mapped, IPv4-translated, and well-known NAT64 `/96` forms before applying the existing IPv4 public-address classifier to their low 32 bits. It also fails closed for other addresses under `64:ff9b::/32`, rather than treating an unsupported translation prefix as native public IPv6.

Independent literal and resolver-path probes confirmed that all of the following are rejected as non-public: `64:ff9b::c0a8:1`, `64:ff9b::a9fe:a9fe`, `::ffff:0:c0a8:1`, `::ffff:0:a9fe:a9fe`, and unsupported `64:ff9b:1::5db8:d822` / `64:ff9b:2::5db8:d822` forms. Dotted IPv4 spellings of the NAT64 and translated metadata/private forms were also rejected. The classifier still accepts well-known NAT64 and IPv4-translated forms carrying `93.184.216.34`, plus ordinary public native IPv6 such as `2001:4860:4860::8888` and `2606:2800:220:1:248:1893:25c8:1946`.

This remains deliberately a pure classification layer, not a claim of sufficient network enforcement: `browserPolicy.ts:54-57` says it neither fetches nor proxies a destination, and `browserRuntime.ts:26` continues to require connection-time network-boundary enforcement. The architecture's Chromium interception and authoritative egress-boundary requirements remain unchanged; no browser runtime is enabled by this target.

#### M2 — Static-client fallback and absent browser API routes

**Outcome: pass — resolved.** `src/server/app.ts:164-165,269-272` reserves the server-side `/api` namespace for JSON 404s before the SPA fallback. Under normal `buildApp()` static-client hosting, unmatched `/api`, `/api?probe=1`, `/api/unknown`, absent remote capability discovery, and absent local browser session controls returned HTTP 404 with `application/json` and `{"error":"API route not found"}`. The registered local capability route remained JSON HTTP 200 and was not intercepted.

The non-API SPA fallback remains intact: an independently probed nested client path (`/browser/nested/path?tab=1`) returned the static `index.html`, while `/apiary` remained a non-API fallback path. No client URL construction or reverse-proxy-prefix behavior changed in this remediation.

#### m1 — Trusted principal absence versus provider failure

**Outcome: pass — resolved.** `src/server/browser/browserCapabilityRoutes.ts:25-51` uses an explicit principal-resolution state. An absent provider/principal produces non-retryable `BROWSER_AUTH_REQUIRED`; a throwing provider produces retryable `BROWSER_UNAVAILABLE`. Independent route injection with a provider error containing a sentinel secret confirmed a 200 unavailable capability response without the secret, zero calls to runtime readiness, and no possibility of advertising the browser capability from that failure path. The route logs only the generic dependency-unavailable event at the server boundary.

### Scope, regression, and documentation assessment

- The remediation diff is limited to the prior M1/M2/m1 browser-capability policy, route, app-fallback, and focused-test files. Inspection of the original implementation, remediation diff, `src/server/index.ts`, `src/server/sessiond.ts`, `src/shared/federatedRoutes.ts`, and machine proxy/client boundaries found no URL proxy, header rewrite, cookie exposure, Chromium launch, browser control/session or WebSocket route, remote federation route, private-network access path, or `sessiond` ownership/protocol change.
- The only browser endpoint remains local capability discovery. `buildApp()` still defaults to the side-effect-free unavailable runtime and has no trusted principal provider. The existing browser panel remains the sandboxed, no-referrer iframe viewer; its availability notice and `docs/faq.html` correctly say that remote arbitrary-site browsing is unavailable and headers are not rewritten.
- The architecture document still requires layered connection-time and network-boundary enforcement. The existing package Changeset remains appropriate for the bounded user-visible clarification; no `CHANGELOG.md` edit is appropriate. This Team Leader report is repository-only architecture documentation and does not require a Changeset.

### New findings

| Category | New line-specific findings |
| --- | --- |
| Blocker | None. |
| Major | None. |
| Minor | None. |
| Nit | None. |

### Checks run

| Check | Result |
| --- | --- |
| Review of the original implementation, prior review report, architecture document, and remediation diff | Completed. |
| `git diff --check 16780cd1a6de5598cca422bde7f3c504c62cb338 d211d179c3506e60a917cfe166c860cd5d8a610d` and `git diff --check e4cf2a7622de422b5794f9ee9756b5e13a5a9556 d211d179c3506e60a917cfe166c860cd5d8a610d` | Passed; no whitespace errors. |
| Focused tests: `npm test -- --run src/server/browser/browserPolicy.test.ts src/server/browser/browserCapabilities.test.ts src/server/browser/browserCapabilityRoutes.test.ts src/server/app.browserCapabilities.test.ts` | Passed: 4 files, 65 tests. |
| Independent policy and egress probes using `node --import tsx --input-type=module` | Passed: transition literals and controlled-DNS results above were rejected or allowed according to the resolved M1 policy. |
| Independent static-client `buildApp()` injection probes | Passed: API JSON 404s, registered capability behavior, non-API fallback, and nested SPA path behavior matched the M2 contract. |
| Independent absent-principal/provider-error route-injection probe | Passed: the two outcomes are distinguishable, provider failure is retryable/unavailable, runtime readiness was not called, and the sentinel exception text was absent from the response. |
| `npm run typecheck` | Passed. |
| Focused ESLint over changed TypeScript source and tests | Passed. |
| Changed-path, federation/proxy, browser-runtime, and sessiond inspection | Passed for the bounded scope; no prohibited capability was added. |

## Re-review decision and permitted handoff

**Merge status: true**

**Completion status: pass**

**Next permitted action for PM:** hand off the approved remediation target to the Security Auditor for the required security review. This approval makes the target eligible for that gate only; do not merge or advance QA, documentation, release, deployment, or runtime-ownership work from this review.
