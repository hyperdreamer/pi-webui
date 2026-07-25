# QA validation: fail-closed browser foundation

## QA record

| Field | Value |
| --- | --- |
| Active phase | Quality Assurance |
| Status | **pass** — phase-1 fail-closed foundation only |
| Architecture base | `85840ca918ee37869ac3793b302b81ee5ac70b84` — `docs(architecture): design arbitrary-site browser service` |
| QA target | `c9b90e73d34e99d557a5e8157200b6305561fb4c` — security re-review report; executable target remains `8081d2e21678d58ce00b09b691129905bcb9d173` |
| Implementation chain reviewed | `16780cd1a6de5598cca422bde7f3c504c62cb338`, `d211d179c3506e60a917cfe166c860cd5d8a610d`, `8081d2e21678d58ce00b09b691129905bcb9d173`, and `c9b90e73d34e99d557a5e8157200b6305561fb4c` |
| Prior gate inputs reviewed | `arbitrary-embedded-browser.md`, Team Leader review/re-review, and Security review/re-review |
| Workspace | `/data/home/guest/Development/pi-webui-browser-connection-fix`, branch `agent/browser-connection-fix` |
| Network/deployment policy | Only deterministic local Fastify injection, injected DNS/fetch fixtures, static inspection, build, and test commands were used. No external site, Chromium process, deployment, publish, merge, or push was run. |

## Scope and conclusion

This QA sign-off covers the **currently implemented phase-1 foundation**, not the proposed arbitrary-site remote-browser product.

The implemented scope is deliberately bounded to:

- a side-effect-free `BrowserRuntimeClient` readiness seam whose default is unavailable;
- local capability discovery at `GET /api/machines/local/browser/capabilities`;
- fail-closed trusted-principal, runtime-readiness, and pure URL/DNS/IP policy decisions;
- JSON 404 handling for absent canonical `/api` browser paths while retaining the non-API SPA fallback; and
- the existing sandboxed, no-referrer iframe viewer, now explicitly labelled as lightweight and unavailable for remote browsing.

The code and the user-facing claims are internally consistent with this staged scope. In particular, the shipping entrypoint supplies neither a browser runtime nor a trusted browser-principal provider, so the default capability result is `BROWSER_AUTH_REQUIRED`; it does not launch a browser or permit browser control.

**This is not a sign-off for a future remote Chromium/browserd feature.** No arbitrary-site remote browser, Chromium process, browserd, control/session/stream route, browser WebSocket, remote-machine delegation/federation route, selected-machine remote mode, egress firewall/container, or persistent/ephemeral remote browser profile exists in the target. All full remote-browser acceptance criteria in the architecture remain deferred.

## Test matrix

| Layer / objective | Evidence and cases exercised | Result |
| --- | --- | --- |
| Pure capability unit tests | Trusted-principal requirement, `browser.use`, all modeled readiness prerequisites, malformed values, bounded limits, and safe capability projection. | Pass |
| Pure policy unit tests | Schemes, userinfo, ports, host normalization, exact/wildcard domains, raw-policy rejection, policy-list limits, IPv4/private/metadata addresses, IPv6 loopback/ULA/site-local/non-GUA/Teredo/ORCHIDv2/6to4/NAT64 forms, literal and resolver paths, DNS cardinality, resolver failures, deadline/abort/timer cleanup. | Pass |
| Capability-route tests | No provider, absent principal, throwing principal provider, redaction, runtime-readiness failure, safe injected readiness, and absent local/remote controls. | Pass |
| Fastify + static-client integration | Built `dist/client` was served through `buildApp()` and locally injected. Default capability was unavailable; remote capability and local session probes were JSON 404s; canonical `/api`, `/api?probe=1`, and `/api/unknown` were JSON 404s; non-API nested paths and `/apiary` received the SPA document. | Pass |
| Client/UI boundary | `BrowserPanel` tests verified the explicit lightweight-viewer/remote-unavailable notice and preservation of `sandbox="allow-forms allow-scripts"` plus `referrerpolicy="no-referrer"` on the iframe. Production client build passed. | Pass |
| Security-boundary regression | Reviewed target/base diffs and source boundaries. Local fixture verified machine configured cookies/authorization are filtered, only the machine service credential is used, and both federation allowlists contain zero browser routes. | Pass |
| Runtime/session regression | Target/base diff contains no `src/server/sessiond.ts`, machine proxy/client, or federation-allowlist modification. Entry-point/source inspection found only readiness/capability code; no runtime launch, control, proxy, or stream implementation. Full verification includes the unchanged project regression suite. | Pass for the phase-1 absence contract |
| Documentation/release claims | Browser panel, FAQ, Changeset, architecture, Team Leader, and Security claims were compared with code. The current viewer/foundation is described honestly; no remote-browser, Google, header-bypass, or proxy claim is made for shipping behavior. | Pass |
| Production build | TypeScript server/plugin builds and Vite client build completed from source. | Pass |

## Commands and results

Each shell command below used this exact per-command prefix: `source yesconda && cd /data/home/guest/Development/pi-webui-browser-connection-fix &&`. The table records the command suffix and result.

| Command | Result |
| --- | --- |
| `git diff --check` | Passed; no workspace whitespace errors. |
| `git diff --check 85840ca918ee37869ac3793b302b81ee5ac70b84 c9b90e73d34e99d557a5e8157200b6305561fb4c` | Passed; no target-range whitespace errors. |
| `npm test -- --run src/server/browser/browserPolicy.test.ts src/server/browser/browserCapabilities.test.ts src/server/browser/browserCapabilityRoutes.test.ts src/server/app.browserCapabilities.test.ts src/client/src/components/BrowserPanel.test.ts` | **5 files passed; 112 tests passed.** |
| `node --import tsx --input-type=module` with an injected policy/DNS/timer fixture | Passed: 16 private/non-public literal and classifier cases denied; 5 domain-allowlist cases checked; public and mixed/oversized DNS answers checked; never-settling resolver aborted at a deterministic 50 ms fixture deadline and cleaned its timer. No DNS lookup was sent to a real resolver. |
| `npm run build` | Passed: server, plugin API, 8 plugin TypeScript files, and Vite production client (248 transformed modules) built successfully. Vite emitted its existing non-blocking large-chunk and ineffective-dynamic-import warnings. |
| `node --import tsx --input-type=module` with `buildApp({ clientDist: resolve('dist/client') })` and `app.inject()` | Passed: default local capability `200` / `BROWSER_AUTH_REQUIRED`; five absent canonical API probes returned JSON `404`; `/browser/nested/path?tab=1` and `/apiary` returned HTML SPA fallback; untrusted `Origin` produced no permissive CORS header. A throwing principal provider returned redacted retryable `BROWSER_UNAVAILABLE` and made zero runtime-readiness calls. |
| `node --import tsx --input-type=module` with injected `RemoteMachineClient` fetch fixture and federation allowlists | Passed: configured `Cookie` and caller `Authorization` headers were absent on the fake remote request; only the machine service bearer token was present; configured sensitive headers were rejected; browser HTTP and WebSocket federation-route counts were both `0`. No fetch reached a network. |
| Target/base diff and production-source inventory over `src/server/sessiond.ts`, `src/server/machines/`, and `src/shared/federatedRoutes.ts` | Passed: all listed boundaries were unchanged. The only browser API registration is local capability discovery; no executable Chromium/browserd/CDP/process launch, control/session endpoint, browser WebSocket, raw destination transport, or browser federation entry was found. |
| `npm run verify` | **Passed:** typecheck, ESLint, Knip, and Vitest. **268 files passed; 2,080 tests passed; 2 skipped** (2,082 total). |

### Local route results

The production-built static-client injection used only local in-process requests:

| Request | Observed response |
| --- | --- |
| `GET /api/machines/local/browser/capabilities` without injected identity | `200 {"available":false,"code":"BROWSER_AUTH_REQUIRED","retryable":false}` |
| `GET /api/machines/remote/browser/capabilities` | JSON `404 {"error":"API route not found"}` |
| `POST` and `GET /api/machines/local/browser/sessions` | JSON `404 {"error":"API route not found"}` |
| `GET /api?probe=1` and `GET /api/unknown` | JSON `404 {"error":"API route not found"}` |
| `GET /browser/nested/path?tab=1` and `GET /apiary` | `200 text/html` SPA fallback |
| Throwing server-side principal provider | `200 {"available":false,"code":"BROWSER_UNAVAILABLE","retryable":true}`; provider text was absent and runtime readiness was not called |

The `/api` reservation is deliberately for canonical application API paths. A manually constructed noncanonical path with the slash percent-encoded immediately after `api` (`/api%2F…`) was treated as a non-API SPA path and did not reach any route or browser control. This is not an application-generated route shape: PI WEBUI application paths retain the literal `/api/` prefix and encode dynamic segments only.

## Regression and security-boundary assessment

- `src/server/index.ts` still calls `buildApp()` without optional browser dependencies. `unavailableBrowserRuntime()` is side-effect free and the absent principal provider short-circuits before readiness is probed.
- The local capability endpoint exposes only a redacted availability projection. It has no URL body, browser commands, session ID, cookie, profile, CDP, stream, or destination-content field.
- Absent browser session/control and remote-machine capability paths return JSON 404 through the normal static-hosting configuration rather than successful SPA HTML.
- `browserPolicy.ts` remains a pure preflight seam: the local deterministic checks exercised URL, public-address, controlled-DNS, list-cardinality, deadline, cancellation, and timer-cleanup behavior. It does not fetch or proxy an external destination.
- The IPv6 and DNS regressions reported by the Team Leader and Security Auditor are covered in the focused suite and independent fixtures: private IPv4 payloads embedded in modeled IPv6 transitions, site-local/non-GUA/Teredo/ORCHIDv2/6to4/unsupported translation prefixes, non-public resolver answers, excessive answers, and a never-settling resolver all fail closed.
- No target-range changes exist in `src/server/sessiond.ts`, machine proxy/client code, or either federation allowlist. There is no browser runtime, Chromium, browserd, browser control/session/WebSocket route, arbitrary website proxy, header rewrite, private-network configuration/path, or session-daemon ownership/protocol change.
- Existing machine-client behavior continues to filter `cookie` and `authorization` configured headers. The independent fake-fetch fixture confirmed that no gateway cookie is forwarded; the only allowed authorization in the fixture was the registered machine service token.

## Documentation and release-claim assessment

The user-visible implementation and documentation consistently describe the present capability:

- `BrowserPanel` calls the current UI a **“Lightweight embedded viewer”**, says remote mode is unavailable, and retains the sandboxed/no-referrer iframe.
- `docs/faq.html` says the viewer is neither a native browser nor a server-side proxy, explains frame-protection/mixed-content limitations, and says no setting rewrites headers or turns it into a proxy.
- `.changeset/fail-closed-browser-foundation.md` accurately calls this a fail-closed foundation and states that arbitrary-site remote browsing remains unavailable until isolated runtime prerequisites are deployed.
- The architecture document labels browserd/Chromium, Google-like top-level navigation, federation/delegation, network enforcement, profile lifecycle, and stream behavior as future design/acceptance work. It does not claim that those pieces are implemented.

The scoped implementation Changeset is appropriate. This QA report is repository-only architecture documentation outside the package `files` allowlist, so no Changeset was added and `CHANGELOG.md` was not edited.

## Coverage quality and deliberate deferrals

The implemented phase has focused automated coverage at the right seams: pure policy/capability logic, Fastify route contracts, static-host fallback integration, and the BrowserPanel rendering boundary. The BrowserPanel check is template-level rather than a rendered-DOM/browser automation test; that is proportionate for this text/iframe-preservation change and is backed by the production client build. A DOM-level component test can be added if the panel gains capability-driven interaction later.

The following are **not applicable and not passed**, because the runtime intentionally does not exist:

- real remote Chromium E2E, including Google or any other external-site navigation;
- top-level rendering of a frame-protected fixture in Chromium;
- browserd lifecycle, sandbox/launch-flag/private-pipe inspection, container mounts, or connection-time egress firewall enforcement;
- browser sessions, tabs, control protocol, frame stream/backpressure, WebSocket-origin/lease checks, reconnect, quotas, idle cleanup, or browser-only restart behavior;
- remote-machine browser federation, delegation expiry/replay/audience tests, selected-machine switching, or remote cookie/profile isolation;
- browserd/UI restart preservation versus active Pi sessions.

No external website was contacted. In particular, a Google/remote-Chromium E2E is deliberately **deferred**, not marked as passed. The architecture requires those future acceptance criteria to be implemented and independently validated before a remote-browser feature can receive QA sign-off.

## Bugs and sign-off

### Reproducible bugs

None found in the implemented phase-1 scope. No production or test fixes were made by QA.

### QA decision

**Completion status: `pass` — phase-1 fail-closed browser foundation only.**

This decision does not approve, imply, or advance a full remote browser, Google support, browserd operation, release, deployment, merge, or publication.

**Next permitted PM action:** PM may arrange the Documentation Agent phase.
