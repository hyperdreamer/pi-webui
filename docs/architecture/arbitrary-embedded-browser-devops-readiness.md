# DevOps readiness: fail-closed browser foundation

## Review record

| Field | Value |
| --- | --- |
| Active phase | DevOps / Infrastructure — release-preparation review only |
| Reviewed target | `4607885efaa6c7031538c9acb665eb722b094b3e` — `docs: clarify fail-closed browser foundation` |
| Phase base | `a00d3490c818b333ff880551665e8e75663a9637` |
| Branch/worktree | `agent/browser-connection-fix` at `/data/home/guest/Development/pi-webui-browser-connection-fix` |
| Scope | Phase-1 unavailable-by-default browser foundation and its package/release posture; no deployment, service action, merge, push, publication, or runtime change |
| Completion status | **pass** — bounded phase only; this is not approval to deploy or publish |

## Deployment status

**No rollout-specific infrastructure action is required by this phase.** The target does not add `browserd`, Chromium, a browser process, a daemon listener/port, a native service, a Docker service/network/mount, a migration, or a runtime-owned browser profile.

The shipped web entrypoint still calls `buildApp()` without either optional browser dependency. `buildApp()` therefore selects the side-effect-free `unavailableBrowserRuntime()`, and supplies no trusted browser-principal provider. A local in-process Fastify probe confirmed the resulting default posture:

| Request | Result |
| --- | --- |
| `GET /api/machines/local/browser/capabilities` | `200` with `{"available":false,"code":"BROWSER_AUTH_REQUIRED","retryable":false}` |
| `GET /api/machines/remote/browser/capabilities` | JSON `404` |
| `POST /api/machines/local/browser/sessions` | JSON `404` |

The one added live route is passive local capability discovery on the existing web/API listener. It provides no browser control, stream, destination URL, cookie, profile, process-launch, or remote-machine route. This is not a new port or reverse-proxy exposure requirement. The fixed HTTP/WebSocket federation allowlists contain no browser route, and the machine client continues to filter `authorization` and `cookie` headers.

## Infrastructure and ownership evidence

### Phase diff and runtime boundaries

The complete `a00d349..4607885` path diff contains only the Browser panel/capability/policy seams, their tests, documentation/review records, and one Changeset. It contains no changes to the following boundaries:

| Boundary checked | Result |
| --- | --- |
| `docker/`, Dockerfiles, Compose files, and CI/infrastructure files | Unchanged |
| Native-service planning, rendering, installation, and extension service integration | Unchanged |
| `src/server/sessiond.ts`, `src/server/sessiond/`, and `src/sessiond/` | Unchanged |
| Machine proxy/client code and `src/shared/federatedRoutes.ts` | Unchanged |
| Configuration/environment parsing and configuration documentation | Unchanged |
| Package manifest and lockfiles | Unchanged |
| Migration paths | Unchanged |
| `src/browserd/` | Absent from the phase diff |

The new `BrowserRuntimeClient` is a readiness-only interface. Its default implementation returns unavailable status, zero limits, and performs no process, network, filesystem, socket, or Chromium/CDP action. The policy module is also explicitly pure: it validates supplied URLs and controlled resolver results but does not fetch, proxy, or launch a browser.

Review of the existing ownership model confirms that `sessiond` remains the long-lived owner of Pi sessions and that the web/API process remains separate. The native development plan still starts `sessiond` with `npm run start:sessiond` and the autoreloading UI service with `npm run dev:web` plus `npm run dev:client`; neither plan gained a browser service. The existing production Compose topology remains `sessiond` plus `web` only.

### Docker/Compose posture

Static inspection of the unchanged Compose and Docker definitions found no browser service, Chromium package, extra port, egress network, volume, mount, environment variable, or Dockerfile runtime change. Existing production Compose exposes only the web service's existing `8808` mapping; development additionally retains its existing Vite `8809` mapping.

`docker compose ... config --no-interpolate --format json` could not be completed because the review environment has no `docker` executable on `PATH`. This is a verification limitation, not a phase regression: no Compose/Docker path changed in the reviewed range, and the source definitions were inspected directly. A deployment environment may perform its normal Compose rendering before a future release, but this phase introduces no Compose input or topology that requires it.

## Environment, URL, secret, and data impact

- No `PI_WEBUI_BROWSER_*` or other Browser-specific environment variable was added; no existing environment variable's use changed.
- No configuration key, `.env` file, secret, service credential, or reverse-proxy setting is required to retain the default unavailable state.
- A production-source diff scan found no added process-launch, raw outbound-transport, listener, browser automation, or secret-bearing declaration. Manual review found no credential, key, token, or password addition.
- No database/schema/data migration, persistent browser profile, cache, cookie store, or `$PI_WEBUI_DATA_DIR` state is created by this phase.
- The current client remains the existing sandboxed, no-referrer iframe viewer. It adds only an explicit unavailable-mode notice and introduces no PI WEBUI-owned HTTP/WebSocket URL construction.
- `docs/faq.html`, `BrowserPanel.ts`, the architecture status note, and the existing Changeset consistently state that remote browsing is unavailable; they do not promise Chromium, `browserd`, header rewriting, a proxy, remote login, or cookie storage.

The architecture document's isolated `browserd` service/container, private control channel, Chromium sandbox, egress firewall, profile storage, credentials, federation delegation, and operational metrics are explicitly **future** requirements. They are not installed, configured, or enabled by this phase.

## Packaging and release metadata

| Check | Result |
| --- | --- |
| `package.json` version and npm lifecycle scripts | Unchanged at `1.5.1`; `prepack` still runs `npm run build` |
| Dependency/lockfile impact | None; no Chromium, browser automation, or runtime dependency was added |
| `npm run build` | Passed: server, plugin API/plugins, and Vite client build completed. Vite emitted only its existing non-blocking chunk-size and ineffective-dynamic-import warnings. |
| `npm pack --dry-run --ignore-scripts --json` after the successful build | Passed: `@hyperdreamer/pi-webui@1.5.1`, 282 files, 4,536,061 unpacked bytes |
| Generated package artifacts | Includes the four compiled fail-closed `dist/server/browser/*.js` modules and maps, plus the existing web, sessiond, and CLI entrypoints |
| Browser runtime artifacts | No packaged `browserd`, Chromium, Puppeteer, or Playwright path/artifact |
| Repository-only material | `docs/faq.html`, architecture/review reports, and `.changeset/fail-closed-browser-foundation.md` are correctly excluded by the npm `files` allowlist |
| `CHANGELOG.md` | Unchanged; it must remain generated during authorized release preparation |

The phase adds exactly one release fragment: `.changeset/fail-closed-browser-foundation.md`, a `patch` fragment whose user-facing text accurately says that arbitrary-site remote browsing remains unavailable pending isolated-runtime prerequisites. No Changeset was added for this DevOps report because it is repository-only documentation outside the package allowlist.

### Release-metadata risk to resolve in PM review

`npm run changelog:status` reports an aggregate **minor** bump for `@hyperdreamer/pi-webui`. The reviewed phase did not cause that result: its only new fragment is the patch fragment above. The minor result comes from pre-existing `.changeset/reorderable-activity-rail.md`, which was already present at `a00d349`. The repository's CalVer Changeset guidance says not to use `minor` for normal releases. Before any branch-wide release preparation, PM must decide the intended release scope and resolve or explicitly approve that pre-existing fragment's policy implication. It is not an infrastructure change or a defect in this phase, but it prevents treating aggregate Changeset output as phase-only release metadata.

The prior Security review also records three pre-existing development-only dependency advisories while the production-only audit was clean. They were not introduced by this phase; retain them as a separate dependency-maintenance risk before a broader release.

## Restart, rollback, and operational posture

- **Session daemon:** no restart is required or authorized. This target does not change sessiond source, protocol, socket ownership, environment, service plan, or package entrypoint dependency path. Active Pi-session ownership remains with the long-lived session daemon.
- **Web/API and UI:** a later authorized package rollout would use the normal existing web/API/UI replacement or autoreload path to serve the updated UI/API. No additional service, port, restart order, browser-session drain, or browserd lifecycle is introduced. The existing iframe viewer has no PI WEBUI-managed remote browser session to preserve.
- **Docker/native services:** no recreate or service-definition update is required beyond the release mechanism normally used for an unchanged topology. No service was restarted during this review.
- **Rollback:** restore the prior package/web/API version through the existing release rollback procedure. There is no migration, new persistent state, browser profile, cookie store, or sessiond change to reverse; a rollback does not require a sessiond restart.

## Verification record

All shell commands used `source yesconda` before execution. No deployment, service-management, publish, GitHub-release, tag, push, merge, destructive command, external browser launch, or production change was run.

| Verification | Result |
| --- | --- |
| Branch/target/history and full phase path-diff inspection | Passed; `HEAD` was the requested target before this report was created |
| `git diff --check` and target-range whitespace check | Passed |
| Infrastructure, native-service, sessiond, federation, configuration, manifest/lockfile, migration, and browserd-path diff assertions | Passed; all listed unaffected boundaries were unchanged |
| Manual source review of web entrypoint, browser runtime/capability/policy routes, sessiond, native service plan, Dockerfiles/Compose, federation, and machine client | Passed for the bounded fail-closed scope |
| In-process Fastify capability/control probe | Passed; default unavailable capability and absent remote/control routes observed as above |
| `npm run build` | Passed with only the existing Vite warnings noted above |
| npm package dry-run inspection | Passed; expected generated `dist` contents and exclusions confirmed |
| Changeset/CHANGELOG inspection | Phase patch fragment present; no manual `CHANGELOG.md` edit; aggregate pre-existing minor-fragment risk recorded |
| Compose resolved-config command | Not run successfully because `docker` is unavailable in this review environment; unchanged source topology inspected directly |

## Completion and permitted handoff

**Completion status: `pass` — phase-1 fail-closed browser foundation only.** No release, deployment, restart, merge, push, tag, or publication is authorized by this report.

**Next permitted PM action:** conduct the PM final release review/HITL only. That review must explicitly decide the scope and policy treatment of the pre-existing minor Changeset before any branch-wide release preparation. If PM later authorizes a release, follow the existing GitHub Actions/Changesets release process; do not infer authorization to deploy, publish, or restart services from this passing readiness assessment.
