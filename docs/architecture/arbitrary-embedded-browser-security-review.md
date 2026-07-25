# Security review: fail-closed browser foundation

## Review record

| Field | Value |
| --- | --- |
| Active phase | Security & Vulnerability Auditor |
| Architecture base | `85840ca918ee37869ac3793b302b81ee5ac70b84` — `docs(architecture): design arbitrary-site browser service` |
| Implementation reviewed | `16780cd1a6de5598cca422bde7f3c504c62cb338` — `feat(browser): add fail-closed remote browser foundation` |
| Hardening remediation reviewed | `d211d179c3506e60a917cfe166c860cd5d8a610d` — `fix(browser): harden fail-closed capability boundaries` |
| Stable target / Team Leader report revision | `82bd6beb1afd16dee340c4d316afe2f3dc0667cd` — `docs(review): re-review browser boundary fixes` |
| Branch and worktree | `agent/browser-connection-fix` at `/data/home/guest/Development/pi-webui-browser-connection-fix` |
| Inputs | Architecture document, both implementation commits and diffs, the current Team Leader report, changed source/tests/docs/Changeset, runtime/federation/sessiond boundaries, manifest and lockfile |
| Audit scope | Independent focused SAST, dependency scan, fail-closed/default-runtime verification, URL/DNS/IP policy review, capability/route review, and user-facing-claim review. No production or test implementation files were changed. |

## Security Scan Report: **FAIL**

The shipping entrypoint remains genuinely unavailable by default, and the prior Team Leader findings around API fallback and principal-provider failure are resolved. However, the new future egress classifier has a major IPv6 public-address classification defect. It permits private/site-local, unallocated, and Teredo transition addresses through both literal-URL and controlled-DNS paths. This makes the foundation unsafe to reuse as a public-only egress gate until corrected and regression-tested.

The failure does **not** create a live browser/SSRF path in this revision: no browser runtime is installed or started by the shipping application. It does block the security gate because the policy is explicitly part of the proposed egress defense and could otherwise be relied upon by the next implementation phase.

## Threat list

### Blocker

None in the shipping default. No Chromium, `browserd`, browser control route, browser WebSocket, remote browser federation route, content proxy, header rewrite, or server-side arbitrary-site fetch is reachable from the production entrypoint.

### Major

#### M1 — The IPv6 `public` classifier allows site-local, unallocated, and Teredo transition destinations

**Locations:**

- `src/server/browser/browserPolicy.ts:236-240` classifies every IPv6 address not matched by a small denylist as public.
- `src/server/browser/browserPolicy.ts:301-312` omits deprecated IPv6 site-local `fec0::/10`, Teredo `2001::/32`, and broad non-global/unallocated ranges; it also omits newer special-use coverage such as ORCHIDv2 `2001:20::/28`.
- `src/server/browser/browserPolicy.test.ts:109-152` tests only selected denylisted prefixes and has no site-local, non-global/unallocated, or Teredo literal/resolver regressions.

**Reproduction:** the following direct, side-effect-free probe returned `true` for classification, literal navigation, and controlled-DNS egress for every address:

```sh
source yesconda && node --import tsx --input-type=module <<'NODE'
import { evaluateBrowserEgress, evaluateBrowserNavigation, isPublicInternetAddress } from './src/server/browser/browserPolicy.ts';

const policy = { mode: 'public-web', allowedDomains: [], allowedPorts: [443] };
const addresses = [
  'fec0::1',
  '4000::1',
  '2001:0000:4136:e378:8000:63bf:5601:5601',
];
for (const address of addresses) {
  console.log(JSON.stringify({
    address,
    classifierAllows: isPublicInternetAddress(address),
    literal: evaluateBrowserNavigation(`https://[${address}]/`, policy).allowed,
    resolver: (await evaluateBrowserEgress('https://resolver.example.test/', policy, { resolve: async () => [address] })).allowed,
  }));
}
NODE
```

Result:

```text
{"address":"fec0::1","classifierAllows":true,"literal":true,"resolver":true}
{"address":"4000::1","classifierAllows":true,"literal":true,"resolver":true}
{"address":"2001:0000:4136:e378:8000:63bf:5601:5601","classifierAllows":true,"literal":true,"resolver":true}
```

`fec0::/10` is deprecated site-local address space and must not qualify as public Internet egress. `4000::/3` is outside the ordinary IPv6 global-unicast allocation, so a blacklist that accepts it cannot establish a public-only invariant. The Teredo example has an obfuscated `169.254.169.254` endpoint field; allowing the whole Teredo transition prefix makes its tunnel/translation behavior unmodeled. The last two forms are not safely distinguished by a generic “not currently denylisted” test.

**Impact:** if a future `browserd` applies this helper before navigation or uses the same classification at its connection perimeter, an internal IPv6 service or transition/tunnel path can be treated as public. That violates the architecture’s requirement to block private, link-local, metadata, and non-public destinations for literals and DNS results. The current default runtime is absent, so there is no presently reachable Chromium egress or SSRF endpoint.

**Required remediation:**

1. Replace the permissive IPv6 blacklist posture with a conservative public-global-unicast allowlist (normally `2000::/3`) plus narrowly modeled exceptions such as the well-known NAT64 prefix carrying a public IPv4 address.
2. Explicitly reject `fec0::/10`, `2001::/32` (Teredo), current IANA special-purpose/non-global ranges including ORCHIDv2, and all unsupported transition/tunnel prefixes. Do not merely decode the Teredo endpoint and allow the rest of its address space.
3. Add literal and resolver-path regression fixtures for site-local, unallocated/non-GUA, Teredo with private/metadata endpoint fields, current transition forms, and public native IPv6.
4. Require the future connection-time egress firewall/proxy to deny non-GUA and transition/tunnel address space independently. It must not reuse this TypeScript classifier as the sole SSRF defense.

### Minor

#### m1 — Policy and resolver cardinality/deadline limits are not enforced by the pure module

**Locations:**

- `src/server/browser/browserPolicy.ts:97-110` awaits the injected resolver without a deadline or cancellation boundary and iterates every returned address.
- `src/server/browser/browserPolicy.ts:124-130` validates every configured domain and port but imposes no maximum collection size.
- `src/server/browser/browserPolicy.ts:188-195` re-normalizes each allowlist entry for every navigation.

The URL itself is capped at 8,192 characters (`:4`, `:133-139`), which is good, but policy arrays and DNS answer cardinality are unbounded. A resolver that never settles also holds the operation indefinitely. The following direct probe reached the caller’s 100 ms timeout, demonstrating that `evaluateBrowserEgress()` has no internal resolver deadline:

```sh
source yesconda && node --import tsx --input-type=module <<'NODE'
import { evaluateBrowserEgress } from './src/server/browser/browserPolicy.ts';
const policy = { mode: 'public-web', allowedDomains: [], allowedPorts: [443] };
const outcome = await Promise.race([
  evaluateBrowserEgress('https://resolver.example.test/', policy, { resolve: () => new Promise(() => undefined) })
    .then(() => 'unexpected-resolution'),
  new Promise((resolve) => setTimeout(() => resolve('caller-timeout-after-100ms'), 100)),
]);
console.log(outcome);
NODE
```

Result: `caller-timeout-after-100ms`.

**Impact:** this has no live request path in the current target, but a future browser runtime could permit a malicious domain’s large DNS answer or an unhealthy resolver to consume worker capacity indefinitely. It is inconsistent with the architecture’s bounded-resource requirement.

**Required remediation:** bound and normalize policy lists once when loading trusted configuration; cap accepted DNS answers; pass a deadline/abort signal to the resolver; and make the runtime enforce a request-level timeout and concurrency budget. Add deterministic tests for an oversized policy/answer and a never-settling resolver.

### Nit

None.

## Static analysis, secret scan, and dependency results

### Changed-code SAST/manual inspection

The implementation diff was reviewed against the architecture and the Team Leader report. A focused static search covered added process execution, outbound HTTP/WebSocket use, proxy/redirect/header operations, secrets, logging, Fastify route registration, and browser-runtime imports.

- No changed production code imports `child_process`, launches Chromium, starts a browser daemon/listener, opens a CDP/debugging port, uses raw `fetch`, `XMLHttpRequest`, `http.request`, `https.request`, `net.connect`, or creates a browser WebSocket.
- No changed production code proxies arbitrary destination content, rewrites framing/security headers, forwards destination cookies, forwards a gateway `Authorization` header, or introduces a redirect handler.
- No hardcoded credential, API key, private key, bearer token, or password was added. Regex matches were documentation/test fixtures such as `user:password`, `token=not-for-logs`, and the prior review’s sentinel-secret description; they are not secrets.
- `src/server/browser/browserCapabilityRoutes.ts:42-49` maps a throwing trusted-principal adapter to a generic retryable unavailable capability and logs only `dependency: "browser-principal-provider"`; it does not emit the exception text. Runtime-readiness errors are likewise redacted at `:29-33`.
- The only added browser route is the local, read-only capability discovery route at `src/server/browser/browserCapabilityRoutes.ts:23-34`. It has no browser-control action, body parser, destination URL, or stream.

Specialized SAST binaries were unavailable on `PATH`: `semgrep`, `gitleaks`, `trivy`, `osv-scanner`, and `grype`. This is a limitation, not a clean result from those tools. The manual changed-code inspection, TypeScript typecheck, ESLint, Knip, focused tests, and full verification were run instead.

### Dependency and lockfile review

- `git diff --quiet 85840ca918ee37869ac3793b302b81ee5ac70b84..82bd6beb1afd16dee340c4d316afe2f3dc0667cd -- package.json package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml` reported no manifest or lockfile change. The browser foundation added no dependency, Chromium package, browser automation package, or lockfile impact.
- `npm audit --omit=dev --json` completed with exit `0`: **0 production vulnerabilities** across 160 production dependencies.
- `npm audit --json` completed with exit `1`: **3 transitive development-only advisories** across the full 714-package dependency tree—`brace-expansion` (two high DoS advisories, GHSA-3jxr-9vmj-r5cp and GHSA-mh99-v99m-4gvg), `postcss` (high source-map path disclosure, GHSA-r28c-9q8g-f849), and `protobufjs` (moderate parser DoS, GHSA-j3f2-48v5-ccww). `npm audit` reported fixes available.

The full audit is therefore **not clean**. These findings are not introduced by the reviewed commits because neither manifest nor lockfile changed, and the production-only audit is clean. They remain repository maintenance risk: update the affected development-tool dependency paths in a separately scoped dependency-maintenance change and rerun full verification/audit before a broad release.

## Verification commands and results

Every isolated shell command was prefixed with `source yesconda`.

| Command | Result |
| --- | --- |
| `source yesconda && git diff --check 85840ca918ee37869ac3793b302b81ee5ac70b84..82bd6beb1afd16dee340c4d316afe2f3dc0667cd` | Passed; no whitespace errors. |
| `source yesconda && npm test -- --run src/server/browser/browserPolicy.test.ts src/server/browser/browserCapabilities.test.ts src/server/browser/browserCapabilityRoutes.test.ts src/server/app.browserCapabilities.test.ts src/client/src/components/BrowserPanel.test.ts` | Passed: 5 files, 70 tests. The suite does not cover M1/m1. |
| `source yesconda && npm run verify` | Passed: `typecheck`, `lint`, `knip`, and Vitest; 268 files passed, 2,038 tests passed, 2 skipped. |
| `source yesconda && npm audit --omit=dev --json` | Passed: npm exit 0; 0 production vulnerabilities. |
| `source yesconda && npm audit --json` | Not clean: npm exit 1; 1 moderate and 2 high transitive development-only vulnerabilities, detailed above. |
| Focused static diff searches over `85840…82bd` for secrets, process execution, raw outbound transport, proxy/redirect/header forwarding, logging, and route declarations | No added secret, process, external transport, proxy, redirect, cookie/authorization forwarding, or unsafe route. The only production log is the generic principal-provider-unavailable warning. |
| Direct `tsx` policy probes shown in M1 and m1 | Reproduced M1 through literal and DNS paths; reproduced the missing resolver deadline. |
| Direct Fastify injection with an untrusted `Origin` | `GET /api/machines/local/browser/capabilities` returned only `{ available: false, code: "BROWSER_AUTH_REQUIRED", retryable: false }` and no `access-control-allow-origin`; unregistered local controls and `OPTIONS` returned JSON 404. |
| `source yesconda && git status --short` after checks | Clean before this report was created. |

## Default fail-closed and boundary assessment

### Confirmed default posture

- `src/server/index.ts:6` calls `buildApp()` without either optional browser dependency. `src/server/app.ts:183` therefore selects `unavailableBrowserRuntime()`; `src/server/browser/browserRuntime.ts:43-57` returns unavailable readiness with zero limits and no side effect.
- `src/server/app.ts:238-240` omits a `BrowserPrincipalProvider` unless a server-only caller injects one. `src/server/browser/browserCapabilityRoutes.ts:25-32` consequently returns `BROWSER_AUTH_REQUIRED` without probing readiness. A provider failure returns redacted, retryable `BROWSER_UNAVAILABLE` at `:25-49`.
- `src/server/browser/browserCapabilities.ts:43-84` requires a server-derived principal with `browser.use` and every modeled readiness assertion—private authenticated control channel, Chromium sandbox, ephemeral per-principal profile isolation, host isolation, private debugging pipe, enforced egress, private-network block, protocol version, and bounded limits—before it can advertise availability.
- The only live browser API is passive local capability discovery. There is no session/control route, WebSocket, CDP channel, remote-machine browser route, browser federation allowlist entry, private-network configuration key, or browser process/daemon in this target.
- `src/server/app.ts:164-165,269-272` reserves `/api`, `/api/…`, and `/api?…` for JSON 404 responses ahead of the SPA fallback. The focused and full route tests confirm absent browser controls do not become successful static-client responses.
- No CORS plugin or permissive origin response was added. The direct `Origin`/preflight probe found no `access-control-allow-origin` header; the endpoint is read-only and returns no credential or runtime detail in the default state.

### Required architecture constraints remain intact

The pure policy is **not** a substitute for a network boundary. It has no network I/O itself and its comments correctly state that Chromium requires connection-time interception and an enforced egress perimeter. This audit’s M1 proves why that condition must remain non-negotiable: arbitrary operator-specific NAT64/6rd/tunnel schemes and DNS rebinding cannot be made safe by a one-time JavaScript URL/DNS check. A future runtime must enforce each connection at an isolated network boundary, deny private/non-GUA/transition ranges there, disable unreviewed proxy/WebRTC paths, and prove readiness from that implementation before capability advertising is enabled.

The existing `BrowserPanel` iframe remains a user-browser request path, not a new server-side remote browser. It still renders a user-entered external URL in a sandboxed, `no-referrer` iframe at `src/client/src/components/BrowserPanel.ts:164-169`. Thus this audit confirms **no new server-side arbitrary-site fetch or egress**, not that the pre-existing lightweight viewer prevents a user’s own browser from loading an external URL.

### Ownership, federation, authentication, and URL-convention regression check

- No `src/server/sessiond.ts`, session-daemon protocol, session ownership, Pi auth, active-profile, machine service/proxy/client, shared federation allowlist, shared capabilities, or client API URL-construction path changed. No session-daemon restart is implicated by this target.
- `src/shared/federatedRoutes.ts:14-118` contains no browser route; `src/server/machines/machineProxyRoutes.ts:23-35` proxies only that fixed allowlist. The existing machine client retains `authorization` and `cookie` filtering at `src/server/machines/machineClient.ts:35-46`.
- No new client application-owned URL is constructed. The changed Browser panel only adds a notice; its pre-existing iframe destination is an external user-entered URL, not a PI WEBUI route. No raw client API fetch or WebSocket was added.

## User-facing claims and release metadata

The reviewed user-visible claims are security-accurate for the current shipping target:

- `src/client/src/components/BrowserPanel.ts:114` labels the panel a lightweight embedded viewer and says remote mode is unavailable.
- `docs/faq.html:137-152` correctly says that the iframe viewer is not a native browser or server-side proxy, framing can fail, and no setting rewrites headers or turns it into a proxy.
- `.changeset/fail-closed-browser-foundation.md:5` accurately says arbitrary-site remote browsing remains unavailable until isolated runtime security prerequisites exist.

The existing Changeset is appropriate for the implementation/user-facing clarification. This security report is repository-only architecture documentation outside the package `files` allowlist; per instruction, it adds no Changeset and does not modify `CHANGELOG.md`.

## Completion and permitted handoff

**Completion status:** `fail`

**Security-report decision:** fail pending M1 and m1 remediation. No security approval for QA is granted.

**Next permitted PM action:** return this stable target **directly to the Programmer, bypassing Team Leader**, for a narrow security-remediation change covering M1 and m1 plus focused literal/DNS/timeout regression tests. The Programmer must not enable a runtime, add browser controls/federation, or alter `sessiond` ownership as part of that correction. After a new stable remediation commit, PM may arrange a fresh Security Auditor review; QA is not permitted until that review passes.

---

## Fresh Security re-review — remediation `8081d2e21678d58ce00b09b691129905bcb9d173`

### Review record

| Field | Value |
| --- | --- |
| Active phase | Security & Vulnerability Auditor — fresh re-review after direct security remediation |
| Security-audit base | `0dc44f45aba10e267c37903d14aec60861bbe3d9` — `docs(security): audit fail-closed browser foundation` |
| Stable remediation target | `8081d2e21678d58ce00b09b691129905bcb9d173` — `fix(browser): harden IPv6 and DNS egress policy` |
| Range reviewed | Direct parent range `0dc44f45aba10e267c37903d14aec60861bbe3d9..8081d2e21678d58ce00b09b691129905bcb9d173`; only `src/server/browser/browserPolicy.ts` and `src/server/browser/browserPolicy.test.ts` changed. |
| Inputs | Accepted [`arbitrary-embedded-browser.md`](arbitrary-embedded-browser.md), the preserved failed report above, remediation diff/source/tests, default runtime/federation/session boundaries, manifest/lockfile status, and user-facing Browser claims. |
| Auditor modifications | This report only. No production or test implementation, runtime owner, `sessiond`, manifest, lockfile, Changeset, or `CHANGELOG.md` file was modified. |

## Security Scan Report: **PASS**

The prior **M1** and **m1** findings are resolved in the reviewed remediation range. The IPv6 classifier is now a conservative public-native-GUA allowlist with explicit, payload-checked exceptions; policy compilation, DNS cardinality, deadline/cancellation, timer cleanup, and failure handling are bounded and deterministic. The shipping default remains unavailable: this target starts no browser runtime and creates no browser-control, proxy, federation, or session-runtime path.

This result does **not** treat the pure TypeScript policy as a network boundary. `browserPolicy.ts:168-171` continues to require connection-time interception, an enforced network boundary, and a concurrency budget for a future runtime. The accepted architecture's layered egress enforcement remains mandatory before any browser capability can advertise availability.

### Prior finding outcomes

#### M1 — IPv6 public-address classification: **pass**

`src/server/browser/browserPolicy.ts:373-450` now:

- permits native IPv6 only from `2000::/3`, then rejects IETF/special-purpose, documentation, 6to4, and AS112 ranges;
- rejects non-GUA/unallocated forms such as `4000::/3`, site-local, ULA, link-local, multicast, Teredo, ORCHIDv2, 6to4, and unsupported NAT64/translation forms;
- recognizes only four exact IPv4-embedded prefixes (`::/96`, IPv4-mapped, IPv4-translated, and well-known `64:ff9b::/96`) and applies the existing public-IPv4 classifier to each low 32-bit payload; and
- fails closed for malformed/unknown textual addresses because Node `isIP()` gates the custom IPv6 parser at `:196-202`.

Independent literal and controlled-resolver probes confirmed matching allow/deny decisions for public native GUA, site-local, non-GUA/unallocated, Teredo, ORCHIDv2, 6to4, locally assigned/unsupported NAT64, well-known NAT64 with public versus RFC1918 payloads, and IPv4-compatible/mapped/translated public versus loopback/metadata payloads. WHATWG URL canonicalization also rejected dotted/alternate loopback spellings (`2130706433`, octal/hex dotted forms, and short dotted forms) and dotted IPv4-mapped/NAT64 private forms. No probe allowed a denied destination through either literal or controlled-DNS evaluation.

#### m1 — Policy/resolver resource bounds and fail-closed behavior: **pass**

`src/server/browser/browserPolicy.ts:98-126,173-263` now compiles and freezes trusted policy once, caps raw domain and port list cardinality at 64 and 16 respectively, rejects invalid/uncompiled policy objects, caps DNS answers at 16 before iterating them, and rejects any non-public answer. The resolver has a 2-second default and a 10-second hard maximum; invalid deadlines (`0`, over-limit, `NaN`, or infinity) fail closed before invoking the resolver.

Independent deterministic timer probes verified that a never-settling resolver receives an abort signal and a deadline, returns generic `dns-unavailable` after expiry, and leaves zero pending timers. A successful resolution also clears its timer. A resolver error is mapped to the same generic denial; resolver exception text is not included in the policy decision. A caller can select only a bounded test seam deadline, not disable or extend it beyond the hard maximum. The pure module has no current production caller; any future browser runtime must still own resolver implementation limits and concurrency budgets rather than accepting caller-controlled timeouts.

### New line-specific findings

| Category | Findings |
| --- | --- |
| Blocker | None. |
| Major | None. |
| Minor | None. |
| Nit | None. |

## Default posture and boundary regression assessment

- The remediation range changes neither `src/server/index.ts`, `src/server/app.ts`, `src/server/sessiond.ts`, machine proxy/client code, shared federation allowlists, client API construction, user-facing FAQ/Changeset, nor dependency files. `git diff --name-status` for those boundaries is empty.
- `src/server/index.ts` still calls `buildApp()` without a browser runtime or trusted browser-principal provider. `src/server/app.ts:183,238-240` therefore supplies the side-effect-free unavailable runtime and omits an identity provider. Independent Fastify injection returned `BROWSER_AUTH_REQUIRED` for the only local capability-discovery route, while local browser session controls and remote browser capability discovery returned JSON 404s. No CORS allow-origin header was emitted for an untrusted Origin.
- `src/server/browser/browserRuntime.ts:43-57` remains readiness-only and unavailable by default. No Chromium/browserd/CDP/control listener, browser WebSocket/session route, raw external fetch, private-network setting, proxy/header rewrite, destination-cookie forwarding, or browser federation route was added. `FEDERATED_HTTP_ROUTES` and `FEDERATED_WEBSOCKET_ROUTES` contain no browser route; the existing machine-client `authorization`/`cookie` filtering remains unchanged.
- The current Browser panel is still the pre-existing sandboxed, `no-referrer` user-browser iframe and accurately says remote mode is unavailable. `docs/faq.html:141-149` and `.changeset/fail-closed-browser-foundation.md` accurately describe it as a lightweight embedded viewer, not a native remote browser or server-side proxy. No user-facing claim promises framing bypass, header rewriting, or arbitrary-site remote browsing.
- No `sessiond` source, protocol, ownership, or lifecycle path changed. A session-daemon restart is neither required nor performed.

## Static analysis, secrets, and dependency review

### Changed-code SAST and secrets review

A manual changed-code SAST search over the exact target/base diff found no added process launch, Chromium/browserd import, raw outbound transport (`fetch`, `http`/`https` request, socket/WebSocket), Fastify browser-control route, proxy, redirect/header rewrite, cookie/authorization forwarding, or secret-bearing assignment. The changed production module is a pure parser/classifier/resolver-preflight seam; it makes no network request itself.

`semgrep`, `gitleaks`, `trivy`, `osv-scanner`, and `grype` were unavailable on `PATH`, so no clean result is claimed from those specialized tools. This is a scan limitation. Manual diff inspection, TypeScript checks, ESLint, Knip, focused tests, full verification, and npm's advisory audit were run instead.

### Manifest/lockfile and dependency audit

- No manifest or lockfile changed in `0dc44f45aba10e267c37903d14aec60861bbe3d9..8081d2e21678d58ce00b09b691129905bcb9d173`; no browser automation/runtime dependency was introduced.
- `npm audit --omit=dev --json` exited `0`: **0 production vulnerabilities** across 160 production dependencies.
- `npm audit --json` exited `1` with three transitive vulnerable-package entries outside the production-only audit: `brace-expansion` has two high DoS advisories (GHSA-3jxr-9vmj-r5cp and GHSA-mh99-v99m-4gvg), `postcss` has one high source-map path disclosure (GHSA-r28c-9q8g-f849), and `protobufjs` has one moderate parser DoS (GHSA-j3f2-48v5-ccww). The full development tree is therefore not clean. These are pre-existing in this unchanged dependency graph and do not block this focused remediation's production security decision; track their upgrade separately before a broader release.

## Verification evidence

Every isolated shell command was prefixed with `source yesconda`.

| Check | Result |
| --- | --- |
| `git diff --check 0dc44f45aba10e267c37903d14aec60861bbe3d9 8081d2e21678d58ce00b09b691129905bcb9d173` | Passed; no whitespace errors. |
| Focused browser policy/capability/panel tests | Passed: 5 files, 112 tests. |
| Direct TypeScript IPv6 literal/resolver and ambiguous-URL probes | Passed: all required deny cases were denied on classifier, literal, and resolver paths; public native GUA and explicitly modeled public-IPv4 payload exceptions allowed. |
| Direct deterministic resolver probes | Passed: oversized answer denied; never-settling resolver aborted with generic denial and timer cleanup; successful result cleanup verified; invalid deadline values invoked no resolver and denied. |
| Direct default `buildApp()` route injection | Passed: default capability is unavailable, browser sessions/remote capability are absent JSON 404s, and no permissive CORS header was present. |
| `npm run typecheck` and focused ESLint over the two remediation files | Passed. |
| `npm run verify` | Passed: typecheck, lint, Knip, and Vitest; 268 files passed, 2,080 tests passed, 2 skipped. |
| Production dependency audit | Passed: `npm audit --omit=dev --json` found 0 production vulnerabilities. |
| Full dependency audit | Not clean, pre-existing advisory limitation recorded above; npm exit 1. |
| Static changed-diff searches and manual inspection | Passed for the reviewed scope; specialized scanner availability limitation recorded above. |

The report is repository-only architecture/security documentation outside the package `files` allowlist. Per the request and Changeset policy, no Changeset was added and `CHANGELOG.md` was not edited.

## Completion and permitted handoff

**Completion status:** `pass`

**Security-report decision:** **PASS** — M1 and m1 are resolved; no new Blocker, Major, Minor, or Nit finding was identified in the target/base range.

**Next permitted PM action:** PM may arrange QA. This Security Auditor review does not merge, push, approve/perform QA, release, deploy, publish, alter runtime ownership, or change `sessiond`.
