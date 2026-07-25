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
