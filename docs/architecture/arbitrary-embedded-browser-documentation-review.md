# Documentation review: fail-closed browser foundation

## Review record

| Field | Value |
| --- | --- |
| Active phase | Documentation Agent / Technical Writer |
| Documentation target | QA-approved phase-1 fail-closed browser foundation at `11a78d28612b9b9679164bcb975145357b0ce412` |
| Workspace | `/data/home/guest/Development/pi-webui-browser-connection-fix` on `agent/browser-connection-fix` |
| Scope | Documentation only. No source, test, configuration, release, deployment, merge, push, or publication change. |
| Completion status | **pass** |

## Scope and conclusion

This review documents the **implemented phase-1 foundation**, not the proposed arbitrary-site remote-browser product. The current Browser is a lightweight, sandboxed, no-referrer iframe viewer. The shipping QA entrypoint has only a passive local capability-discovery seam and supplies neither a trusted browser principal nor a browser runtime, so remote browsing is unavailable by default.

No remote Chromium or `browserd`, browser session/control/stream route, browser WebSocket, destination-content proxy, header rewrite, remote-machine browser delegation, site-login session, or PI WEBUI-managed destination-cookie profile is implemented. The proposed target architecture remains deferred until its authentication, isolation, and connection-time egress prerequisites are implemented and independently approved.

## Inputs reviewed

### Architecture, implementation, and gate records

- Accepted [architecture decision record](arbitrary-embedded-browser.md), including its proposed `browserd` topology, explicit non-goals, and rollout prerequisites.
- [Team Leader review and re-review](arbitrary-embedded-browser-team-leader-review.md).
- [Security audit and re-review](arbitrary-embedded-browser-security-review.md).
- [QA validation record](arbitrary-embedded-browser-qa.md) for the target commit.
- Implemented panel and foundation seams: [`BrowserPanel.ts`](../../src/client/src/components/BrowserPanel.ts), [`browserRuntime.ts`](../../src/server/browser/browserRuntime.ts), [`browserCapabilities.ts`](../../src/server/browser/browserCapabilities.ts), and [`browserCapabilityRoutes.ts`](../../src/server/browser/browserCapabilityRoutes.ts).
- Programmer documentation/release fragment: [`docs/faq.html`](../faq.html) and [`.changeset/fail-closed-browser-foundation.md`](../../.changeset/fail-closed-browser-foundation.md).

### User-facing documentation and package scope

- [`README.md`](../../README.md): retained without change. Its product overview and quick start do not claim remote browsing, and detailed Browser limitations belong in the FAQ.
- [`docs/faq.html`](../faq.html): canonical Browser-limitation guidance; updated for explicit phase-1 boundaries.
- [`docs/config.md`](../config.md) and [`docs/config.html`](../config.html): reviewed without change. No Browser configuration key, environment variable, runtime, or operational procedure is implemented, so adding one would be inaccurate.
- [`package.json`](../../package.json): reviewed to assess publication scope and the Changeset decision.

## Documentation changes

| File | Change | Rationale |
| --- | --- | --- |
| [`docs/faq.html`](../faq.html) | Names `X-Frame-Options` and CSP `frame-ancestors` as iframe-framing limits; explicitly states that remote mode is unavailable in this installation; states that there is no remote Chromium/`browserd`, control/pixel stream, remote site-login session, or PI WEBUI-managed destination-cookie storage; preserves the no-proxy/no-header-rewrite boundary; states the future security prerequisites at a high level. | Removes ambiguity without offering unimplemented setup steps or configuration. |
| [Architecture decision record](arbitrary-embedded-browser.md) | Adds a short phase-1 implementation-status note immediately below its proposed-design status. | Separates the implemented unavailable-by-default foundation from the document's future target topology and preserves the decision record. |
| `docs/architecture/arbitrary-embedded-browser-documentation-review.md` | Adds this durable Documentation Agent review record. | Records scope, truthfulness evidence, release-note decision, verification, status, and permitted handoff. |

No changes were made to `README.md`, `docs/config.md`, `docs/config.html`, source, tests, configuration, `CHANGELOG.md`, or the existing Changeset.

## Truthfulness checks

| User-facing claim or boundary | Evidence and conclusion |
| --- | --- |
| The current Browser is an iframe viewer. | `BrowserPanel.ts` renders an iframe with `sandbox="allow-forms allow-scripts"` and `referrerpolicy="no-referrer"`. FAQ wording calls it a lightweight embedded viewer, not a native browser. |
| Framing and mixed-content limits are real. | The FAQ states that `X-Frame-Options` and CSP `frame-ancestors` can prevent framing, and that an HTTPS PI WEBUI deployment can have its browser block an HTTP page as mixed content. It does not promise a workaround. |
| PI WEBUI does not proxy content or bypass header policy. | The FAQ explicitly says no setting rewrites page headers or turns the viewer into a proxy. QA and Security records confirm no destination-content proxy, header rewrite, or arbitrary-site server-side fetch route. |
| Remote mode is unavailable by default in this installation. | The BrowserPanel notice says so. The shipping entrypoint supplies no trusted principal provider and uses the side-effect-free unavailable runtime; QA observed `BROWSER_AUTH_REQUIRED` from the passive local capability endpoint. |
| There is no remote Chromium/site-login/cookie/streaming support today. | Source and QA records show no Chromium/`browserd`, browser sessions, controls, streams, WebSocket, remote federation, browser profile, or destination-cookie API. The FAQ distinguishes this from the ordinary cookie policy applied by the user's iframe-capable browser. |
| Future architecture is not presented as shipped behavior. | The architecture now explicitly labels phase 1 as a limited foundation and retains `browserd`, private control, sandboxing, authenticated principal, and public-web egress as future prerequisites. It does not claim Google support or any third-party restriction bypass. |
| No unimplemented configuration was documented. | The configuration references contain no Browser key. The FAQ says the future security prerequisites are not deployed or configurable today; it gives no speculative configuration or operational instructions. |

## Changeset and changelog decision

The existing [patch Changeset](../../.changeset/fail-closed-browser-foundation.md) remains accurate: it describes the lightweight embedded viewer and fail-closed remote-browser capability foundation while stating that arbitrary-site remote browsing remains unavailable pending isolated-runtime security prerequisites.

No additional Changeset was added. These documentation edits clarify the same already-described user-visible boundary; this review report is repository-only architecture documentation and is outside the npm package `files` allowlist. `CHANGELOG.md` was not edited manually.

## Verification evidence

All commands were run locally with `source yesconda && cd /data/home/guest/Development/pi-webui-browser-connection-fix &&` as their prefix. No external site, browser runtime, deployment, publish, merge, or push command was run.

| Check | Exact result |
| --- | --- |
| `git diff --check` before staging and `git diff --cached --check` after staging | **Pass** — no whitespace errors in the tracked or newly added documentation files. |
| Python standard-library local-link and content check over `docs/faq.html`, `docs/architecture/arbitrary-embedded-browser.md`, and this report | **Pass** — 30 FAQ local references and 15 local fragment references resolved; 7 architecture and 18 review-report local Markdown references resolved; 12 required fail-closed content assertions passed. |
| Commit hook: `npm run verify:staged` | **Pass** — cached whole-project typecheck and Knip completed; related Vitest selection passed 1 file / 4 tests; no staged file required ESLint. |
| Scoped documentation claim review against BrowserPanel, runtime/capability sources, architecture, Team Leader, Security, QA, README, config references, and Changeset | **Pass** — no reviewed user-facing text claims arbitrary-site remote Chromium browsing, Google support, browserd operation, remote site-login/cookie profiles, streaming/control routes, proxy behavior, or header-policy bypass. |

No documentation-specific build or lint command is configured for these static HTML/Markdown files. The checks above are the narrowest applicable documentation/content verification; the QA record supplies the prior source/test/build evidence for the fixed QA target.

## Completion and permitted handoff

**Completion status: `pass`.** This documentation phase makes the candidate eligible only for DevOps/release-preparation review.

**Next permitted PM action:** PM may hand the documentation-complete QA candidate to DevOps for release-preparation review. This record does not authorize a merge, push, release, publication, deployment, or release/deployment approval; DevOps must request PM/HITL approval before any production deployment.
