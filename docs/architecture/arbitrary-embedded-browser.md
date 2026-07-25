# Arbitrary-site browser architecture

**Architecture phase status:** `pass` — proposed design only; no feature, runtime-owner, deployment, or third-party restriction bypass is implemented by this document.

**Phase-1 implementation status (QA commit `11a78d28612b9b9679164bcb975145357b0ce412`):** The implemented foundation is limited to unavailable-by-default capability/readiness/policy seams and clear lightweight-iframe labeling. It does not implement `browserd`, Chromium, browser sessions, control or streaming routes, remote-machine delegation, remote site login or cookie profiles, or an egress runtime. The remainder of this document is the proposed target architecture and is not shipped behavior.

**Source revision reviewed:** `a00d3490c818b333ff880551665e8e75663a9637` (`agent/browser-connection-fix`, merged `main`)

**Commit intent:** `docs(architecture): design arbitrary-site browser service`

## Decision summary

Replace the current arbitrary-site **iframe** path with an opt-in, selected-machine **remote Chromium browser runtime** for sites that need ordinary top-level browser behavior. The proposed runtime is called **`browserd`** below. It runs Chromium in a separately isolated environment on the selected PI WEBUI machine, renders pixels to the PI WEBUI client over a same-origin, authenticated stream, and accepts only a small, typed input/control protocol.

This is the recommended design because it supports normal top-level browsing without weakening a site's framing policy. It does **not** remove or rewrite `X-Frame-Options`, CSP, CORS, cookies, or other site controls. In particular, a site such as Google receives a normal top-level Chromium navigation rather than an iframe navigation. A site may still reject automation, require a CAPTCHA or WebAuthn, or prohibit the interaction under its own policy; PI WEBUI must report that honestly and must not evade it.

The feature is safe to enable only when all of these conditions are true:

1. The PI WEBUI entrypoint has a trustworthy authenticated principal and authorization decision for each browser request. A host allowlist alone is not an identity system.
2. `browserd` is reachable only over a private authenticated local channel, is sandboxed, and has no direct access to Pi state, workspaces, terminals, agent credentials, or a host Docker socket.
3. An egress policy blocks private, link-local, loopback, metadata, and other non-public destinations at both the browser-control layer and the network boundary.
4. Remote-machine browsing uses an explicit, short-lived, audience-bound delegation model. It never forwards a user's gateway cookies or browser credentials to a remote machine.
5. The Chromium sandbox and the egress enforcement report healthy. The feature fails closed when either is unavailable.

Until those conditions exist, the current iframe remains a **lightweight viewer**, not arbitrary-site support.

## 1. Current repository fit and problem statement

The current browser panel in [`src/client/src/components/BrowserPanel.ts`](../../src/client/src/components/BrowserPanel.ts) is intentionally local client state:

- each tab has an `http` or `https` URL and is rendered as `<iframe src=... sandbox="allow-forms allow-scripts" referrerpolicy="no-referrer">`;
- tabs last only while the panel is open, and its current zoom is a CSS transform persisted in browser local storage;
- the PI WEBUI page cannot inspect a different-origin frame, including its post-link navigation;
- [`docs/faq.html`](../faq.html#embedded-browser) correctly documents it as a lightweight embedded viewer rather than a native browser or server-side proxy.

`X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors` are evaluated by the destination site and deliberately prohibit this embedding shape. They cannot be fixed by changing iframe sandbox tokens. Google is a concrete example: it may refuse to render in the PI WEBUI-origin iframe even though it works as a top-level page.

The surrounding architecture makes the proposed placement clear:

- [`src/server/app.ts`](../../src/server/app.ts) is the browser-facing Fastify web/API edge and is where local aliases, selected-machine routes, and static client hosting meet.
- [`src/server/sessiond.ts`](../../src/server/sessiond.ts) owns long-lived Pi sessions separately, normally behind a Unix socket and proxied by the web/API process. Browser disconnects and web/API restarts must not end Pi sessions.
- [`src/server/machines/machineProxyRoutes.ts`](../../src/server/machines/machineProxyRoutes.ts) federates a fixed allowlist of API and WebSocket paths to registered PI WEBUI machines. It is not a generic proxy.
- [`src/server/machines/machineClient.ts`](../../src/server/machines/machineClient.ts) deliberately filters cookies and sensitive hop-by-hop headers when talking to a remote machine.
- [`docs/config.md`](../config.md) establishes that core machine configuration belongs in the global PI WEBUI config, while `$PI_WEBUI_DATA_DIR` holds PI WEBUI-managed state.

The design therefore adds an optional browser runtime adjacent to the web/API edge. It does **not** add browsing responsibilities to `sessiond`, does not make `sessiond` own browser tabs or cookies, and does not change the existing session-runtime ownership model.

## 2. Options considered

| Option | Can load `SAMEORIGIN`/`frame-ancestors` sites? | Cookie and machine semantics | Security and operational consequences | Decision |
| --- | --- | --- | --- | --- |
| Keep or enhance the iframe | No. The destination still sees an embedded frame. | Cookies are governed by the end user's browser and iframe policy; the selected remote PI machine is not the browsing host. | Small operational cost, but cannot solve the stated problem. Adding permissive sandbox flags would reduce isolation without overcoming framing policy. | Keep only as the clearly labelled lightweight viewer/fallback. |
| Native WebView host (Electron, Tauri, platform WebView) | Usually yes, because the WebView can navigate top-level. | Cookies and egress live on the human's local device, not the selected PI WEBUI machine. | Requires a separately distributed native application and OS-specific sandbox/update work. It excludes ordinary browsers, phones, and the repository's remote-first model. | Do not choose for the web product. It could be a future separate desktop product. |
| Remote Chromium/browser service with rendered pixels and typed control | Yes, when the site accepts an ordinary Chromium navigation. The page is top-level inside Chromium, not framed in PI WEBUI. | Cookies, browser profile, public IP, locale, and egress belong to the selected PI WEBUI machine. | Adds Chromium lifecycle, video/image streaming, quotas, browser sandboxing, and egress policy. Those costs are explicit and can be contained in a dedicated runtime. | **Recommended.** |
| Server-side proxy/rewrite that strips framing headers or rewrites HTML | Not reliably. Modern sites depend on CSP, module loading, Service Workers, WebSockets, SRI, OAuth, and dynamic origins. | The proxy would become a bearer of site cookies and would collapse site content into PI WEBUI's origin. | Creates a generic SSRF surface, breaks site security intent, risks PI WEBUI-origin XSS/cookie exposure, and would bypass third-party restrictions without a defensible model. | Explicitly rejected. Do not implement. |

A generic server-side proxy is especially unsuitable for Google-like sites: stripping `X-Frame-Options` or CSP would be an attempted circumvention, not a supported browser implementation, and it would still fail on many resource and login flows.

## 3. Recommended topology

`browserd` is a proposed independent browser runtime. It is not a rename, child, or extension of `sessiond`.

```text
Human browser
    |
    | HTTPS, reverse-proxy authentication, same-origin HTTP/WebSocket
    v
PI WEBUI gateway web/API process
    |\
    | \-- existing private sessiond client --> sessiond --> Pi sessions, terminals, auth
    |
    +-- Browser Gateway Adapter -- private Unix socket / mTLS private link --> browserd
                                                                        |
                                                                        +-- Chromium browser contexts
                                                                                |
                                                                                +-- enforced public-web egress

For a selected remote machine:

Human browser -> gateway web/API -> fixed machine browser route -> remote PI WEBUI web/API
                                                               -> remote browserd -> Chromium + target-machine egress
```

### Component responsibilities and state ownership

| Component | Owns | Must not own or expose |
| --- | --- | --- |
| Browser panel/client adapter | Presentation, focus, panel geometry, reconnect behavior, and only opaque browser/session/tab IDs. | Destination HTML, DOM, cookies, DevTools commands, browser profile files, or a destination-network connection. |
| Gateway/target web API Browser Gateway Adapter | Authentication, authorization, route validation, selected-machine resolution, policy lookup, typed API translation, and audit correlation. | Destination response bodies, `Set-Cookie`, page source, Chromium debugging access, or an arbitrary outbound URL proxy. |
| `browserd` | Authoritative browser session/tab state, browser-context lifecycle, ephemeral cookie/profile storage, viewport/zoom state, frame production, and Chromium process supervision. | Pi sessions, agent profile data, workspaces, terminal access, gateway authentication cookies, or a public TCP listener. |
| Chromium worker | One isolated browser context per authorized PI WEBUI browser session. | Any host file URL, extension, arbitrary CDP client, local-network exception, or shared profile with another principal. |
| Egress enforcement | DNS/address classification and connection policy for all Chromium traffic. | A user-controlled bypass, an implicit private-network route, or a broad host network namespace. |
| Existing `sessiond` | Pi session lifetime and existing session/terminal/auth behavior. | Browser sessions, browser cookies, Chromium, egress policy, or browser rendering. |

The browser runtime should be a deep module with one small external interface: create/inspect/mutate/attach/terminate a browser session. Its Chromium/CDP adapter, stream encoder, profile cleaner, DNS resolver, and process supervisor remain internal implementation details. The web/API edge receives an injected `BrowserRuntimeClient`; tests can substitute a fake without launching Chromium.

### Browser process model

The initial implementation should use a pinned, vetted Chromium build launched with `--remote-debugging-pipe`, not a TCP debugging port. A `puppeteer-core`-style CDP adapter or a narrow direct CDP adapter is acceptable, provided it does not auto-download a browser at runtime. `Page.startScreencast`-style JPEG/WebP frames plus CDP input dispatch are a practical first transport; a later WebRTC encoder may replace the transport behind the same stream interface.

The browser launch must preserve Chromium's own sandbox. `--no-sandbox`, `--disable-web-security`, remote debugging over TCP, unrestricted extensions, and a user-configurable Chromium command are prohibited. If the host/container cannot provide the required sandbox, readiness is false and arbitrary-site browsing remains disabled.

## 4. Key data flows

### 4.1 Local selected-machine creation and navigation

1. The PI WEBUI client sends a same-origin `POST` to `api/machines/local/browser/sessions`.
2. The web/API edge obtains the authenticated principal from an approved authentication adapter. It derives the owner and permissions on the server; the client cannot submit an owner ID.
3. The web/API edge validates that the browser capability is healthy, checks per-principal quotas, obtains the target machine's browser configuration, and asks `browserd` over its private channel to create an ephemeral browser context.
4. `browserd` launches or leases a Chromium worker, registers a random opaque browser-session ID, and returns a redacted snapshot. It never returns cookies, request headers, profile paths, or DevTools information.
5. The client opens one same-origin WebSocket stream for that opaque session. The stream receives a state snapshot and rendered frames. The client sends only validated input/control messages.
6. When navigation is requested, `browserd` validates the candidate URL, applies the egress policy, then asks Chromium to perform a normal top-level navigation. Redirects and subresource connections are checked again by the network enforcement layer.
7. Chromium emits committed URL/title/history/viewport state and encoded frames. The browser panel renders them into a canvas or image surface; it never inserts destination markup into PI WEBUI's DOM.

### 4.2 Authentication to a destination website

A user may type site credentials into the rendered remote page. The key properties are:

- the destination receives the credentials through Chromium like a normal browser flow;
- destination cookies remain in that one Chromium browser context and are never serialized into PI WEBUI API responses, gateway logs, machine proxy headers, or the client application;
- the PI WEBUI gateway and selected machine necessarily see the encrypted browser-control path and pixels, so the UI must disclose that this is remote browsing on the selected machine;
- default profiles are ephemeral and are destroyed on explicit browser-session close or idle expiry. There is no initial import from the user's local browser, Chrome profile, or PI auth state;
- persistent named browser profiles are a later, separately reviewed capability. They require per-principal ownership, encrypted-at-rest/OS-keyring policy appropriate to the platform, explicit retention controls, deletion, and audit design before being offered.

WebAuthn/passkeys, client certificates, local file chooser access, camera, microphone, geolocation, notifications, clipboard synchronization, DRM, and downloads/uploads are disabled or unsupported in the first release. The UI must say when a site requires one of these capabilities and offer a normal external-browser link rather than attempting a workaround.

### 4.3 Browser disconnects and restarts

A stream disconnect detaches the client, not the Chromium context. `browserd` keeps the context for a short, configurable reconnect lease (proposed default: 10 minutes) and independently enforces a short idle lifetime (proposed default: 30 minutes). The owner can explicitly close it earlier.

- A UI/API autoreload or restart must not terminate `browserd` contexts merely because the adapter reconnects.
- A `browserd` restart terminates only its browser contexts and removes ephemeral profiles. It must surface a recoverable browser-only failure.
- A `sessiond` restart has no browser effect; a browserd failure has no Pi-session effect.
- A panel close explicitly terminates the ephemeral session by default. It does not leave a hidden authenticated website open.

This preserves the repository's existing rule that the long-lived session daemon, rather than the browser UI, owns Pi sessions. It does not change any current runtime owner.

### 4.4 Remote-machine flow

Browsing is scoped to the **selected machine**, just as projects, sessions, terminals, and files are. A site sees the selected machine's egress IP and its cookies/cache exist only there. The gateway must never silently start a browser on itself when the selected remote machine lacks support.

```text
client
  -> gateway /api/machines/<encoded-machine-id>/browser/...
    -> registered-machine client (fixed allowed route only)
      -> remote PI WEBUI web/API validates delegation
        -> remote browserd owns context and egress
```

The gateway resolves `<machine-id>` only through the existing registered-machine store. It never accepts a destination PI WEBUI URL or arbitrary website URL as a proxy target. The remote hop carries the existing machine service credential plus a **separate browser delegation envelope** with all of the following properties:

- signed or mutually authenticated by the gateway/remote pair;
- short lived (at most a minute), audience-bound to the registered target machine and browser route;
- bound to the authenticated subject, permissions, machine ID, browser session/lease, nonce, and expiry;
- replay resistant and rejected by a target that has not opted into delegation;
- never a forwarded browser cookie, user `Authorization` header, reverse-proxy identity header, or destination-site credential.

The exact token format may be JWS, a MACed capability, or an equivalent mutually authenticated RPC credential, but these claims are mandatory. Remote browsing remains unavailable when the target cannot verify the delegation or does not advertise the matching capability. This is deliberately stricter than current single service-token federation because browser cookies and rendered content need per-principal isolation.

## 5. API and protocol contracts

All browser-owned client references stay application-relative, for example `api/machines/${encodeURIComponent(machineId)}/browser/...`, and resolve once through the existing `request()` / `resolveAppUrl()` / `resolveAppWebSocketUrl()` boundaries. This retains nested reverse-proxy-prefix support.

### 5.1 Capability negotiation

Add a new known capability, proposed name `browser.remote`, that is advertised by the web runtime only when its browser adapter reports all required readiness checks. It must not be advertised just because the installed package is new.

```json
{
  "available": true,
  "protocolVersions": [1],
  "profileModes": ["ephemeral"],
  "limits": { "maxTabsPerSession": 10, "maxSessionsPerPrincipal": 2 },
  "egress": { "mode": "public-web", "privateNetworksBlocked": true }
}
```

Proposed route:

```text
GET /api/machines/:machineId/browser/capabilities
```

A local alias handles `local`; remote support is added to the explicit `FEDERATED_HTTP_ROUTES` allowlist. Older gateways or targets return no capability/404 and the UI renders the lightweight-viewer limitation, not a broken remote browser.

### 5.2 Control resources

All IDs below are server-generated opaque identifiers with bounded length. The `machineId` is URL encoded by the client. Every mutation requires the authenticated principal to own the browser session or have an explicit administrative permission.

| Method and route | Request | Response / semantics |
| --- | --- | --- |
| `POST /api/machines/:machineId/browser/sessions` | Optional initial viewport; no owner, cookie, or Chromium options. | `201 BrowserSessionSnapshot`. Creates one ephemeral context after quota/policy checks. |
| `GET /api/machines/:machineId/browser/sessions/:sessionId` | — | Redacted snapshot for reconnect/state recovery. |
| `DELETE /api/machines/:machineId/browser/sessions/:sessionId` | — | Terminates Chromium context and securely deletes ephemeral profile data. Idempotent close is preferred. |
| `POST .../sessions/:sessionId/tabs` | `{ "url"?: "https://..." }` | Creates/activates a tab. A supplied URL receives the same navigation policy as address-bar navigation. |
| `POST .../tabs/:tabId/navigate` | `{ "url": "https://..." }` | Begins a user-initiated top-level navigation. It never fetches through Fastify. |
| `POST .../tabs/:tabId/back`, `/forward`, `/reload`, `/stop` | — | Performs the named browser operation when legal. |
| `POST .../tabs/:tabId/activate` | — | Makes the tab active in the server-authoritative session snapshot. |
| `PATCH .../tabs/:tabId/viewport` | `{ "widthCssPx": 1280, "heightCssPx": 720, "deviceScaleFactor": 1 }` | Bounded viewport update; browserd reports the effective viewport. |
| `PATCH .../tabs/:tabId/zoom` | `{ "percent": 100 }` | Sets browser-engine page zoom (bounded 50–200), not only a CSS scale of the received image. |
| `DELETE .../tabs/:tabId` | — | Closes the tab; closing the last tab follows the explicit session-close policy. |

A `BrowserSessionSnapshot` contains only safe projection data:

```json
{
  "id": "opaque-session-id",
  "machineId": "local",
  "profileMode": "ephemeral",
  "activeTabId": "opaque-tab-id",
  "tabs": [
    {
      "id": "opaque-tab-id",
      "title": "Example",
      "url": "https://example.test/path",
      "displayUrl": "https://example.test/path",
      "state": "ready",
      "canGoBack": false,
      "canGoForward": false,
      "zoomPercent": 100
    }
  ],
  "expiresAt": "2026-01-01T00:00:00.000Z"
}
```

`url` can contain a user-visible query or fragment but must be redacted before logs/metrics. Userinfo (`https://user:password@host/`), unsupported schemes, control characters, oversized URLs, and malformed internationalized hosts are rejected before Chromium sees them. The client never gets a cookie list, response headers, HTML, console log, network archive, CDP error, or profile location.

Browser-specific errors retain the existing JSON error convention while adding a stable code:

```json
{
  "error": "Browser navigation blocked by the selected machine's egress policy",
  "code": "BROWSER_EGRESS_BLOCKED",
  "retryable": false,
  "requestId": "opaque-correlation-id"
}
```

Expected codes include `BROWSER_AUTH_REQUIRED`, `BROWSER_FORBIDDEN`, `BROWSER_UNAVAILABLE`, `BROWSER_CAPACITY_EXCEEDED`, `BROWSER_EGRESS_BLOCKED`, `BROWSER_SESSION_EXPIRED`, `BROWSER_MACHINE_UNAVAILABLE`, and `BROWSER_DELEGATION_UNSUPPORTED`.

### 5.3 Stream protocol

Proposed stream route:

```text
GET /api/machines/:machineId/browser/sessions/:sessionId/stream  (WebSocket)
```

The browser connects through the same authenticated application origin as other PI WEBUI sockets. Do not put bearer tokens, browser credentials, or destination URLs in the query string. Cookie-authenticated deployments must enforce SameSite/CSRF/origin protections for mutations and check the WebSocket `Origin`; authenticated reverse proxies must protect HTTP **and** WebSocket routes under the application prefix.

The stream begins with a UTF-8 JSON `hello` message containing protocol version, effective viewport, active tab snapshot, and a lease generation. It then carries:

- server-to-client JSON events: `tab.updated`, `navigation.started`, `navigation.committed`, `navigation.failed`, `navigation.blocked`, `popup.requested`, `session.expiring`, and `session.closed`;
- server-to-client binary frame packets: a four-byte metadata length, UTF-8 JSON metadata (`type`, `sessionId`, `tabId`, monotonic `frameId`, dimensions, codec), then image bytes;
- client-to-server bounded JSON input messages: pointer, wheel, key down/up, text insertion, focus, viewport change, and latest-frame acknowledgement.

The stream protocol is not a general VNC/CDP tunnel. It has no `evaluate`, `network`, `cookie`, `header`, `download-path`, `file-upload`, DevTools, or arbitrary command message. Coordinates are mapped against the broker-reported effective viewport and zoom; stale lease generations and events for a non-active tab are rejected. Frames are lossy by design: when a client or gateway is behind, old frames are dropped in favor of the most recent frame instead of building an unbounded queue.

### 5.4 Navigation, popups, tabs, and zoom

`browserd` is authoritative for navigation state because only it can observe cross-origin redirects and same-origin history changes. The address bar updates only from its committed-navigation events, never by trying to read a page iframe.

- A typed address is normalized to `http` or `https`, but every redirect and every destination connection remains subject to policy.
- `target=_blank`/`window.open` is intercepted. It becomes a `popup.requested` event and opens a tab only after an explicit user action tied to the active stream; untrusted pages cannot create unlimited hidden tabs.
- Links, form submissions, client-side routing, and history navigation use Chromium's ordinary browser behavior.
- Browser page zoom is per tab/session and applied through the browser engine. Resizing the PI WEBUI panel changes the remote viewport; the panel does not pretend that a CSS transform is page zoom.
- The external-browser escape hatch opens the normalized destination with `noopener,noreferrer` in the human's own browser. It never transfers the remote Chromium cookie jar.

## 6. Security model and threat model

### 6.1 Authentication and authorization

PI WEBUI currently documents trusted users and trusted server paths. Arbitrary browsing raises the risk enough that the browser feature must require a concrete principal source rather than infer identity from `Host`, `allowedHosts`, a machine ID, or a client-supplied header.

Approved deployment modes are limited to:

1. a local, loopback/OS-bound single-user deployment with a trustworthy local-user boundary; or
2. an authenticated reverse proxy or application authentication adapter whose identity header is accepted only from a configured trusted proxy path and cannot be forged by a direct client.

If no principal is available, `browser.remote` is unavailable and the API returns `BROWSER_AUTH_REQUIRED`. The feature must not be enabled merely because PI WEBUI is reachable on a private LAN.

Authorization introduces distinct permissions, at minimum:

- `browser.use` — create, control, attach to, and delete the caller's ephemeral browser sessions;
- `browser.admin` — inspect safe operational state and terminate sessions under an audited policy;
- `browser.persistent-profile` — future-only, explicit persistent-profile permission.

Every browser session is keyed by `(target machine, authenticated subject, opaque session ID)`. A guessed ID, stale WebSocket, another user, a different machine, or a removed remote-machine record cannot attach to it. Existing trusted browser-side plugins remain trusted code under the repository's documented model; this design does not claim to defend against JavaScript already running with PI WEBUI-origin privileges.

### 6.2 Cookies and credential boundaries

| Asset | Required boundary |
| --- | --- |
| PI WEBUI reverse-proxy/app cookies | Used only to authenticate the PI WEBUI request/stream. Never supplied to a destination website. |
| Destination-site cookies, local storage, IndexedDB, cache | Stored only in the owning Chromium browser context/profile on the selected machine. Never returned by API or forwarded through machine federation. |
| Machine registry bearer token | Remains the gateway-to-remote PI WEBUI service credential. It is not a destination-site credential and is never exposed to Chromium. |
| Remote browser delegation | Short-lived, audience-bound authorization envelope; no forwarding of user cookies or browser credentials. |
| Pi/provider/OAuth credentials | Stay in the existing selected-machine Pi/runtime storage and are not mounted into browserd. |

Profiles must be one-per-principal browser session in v1, with a private 0700-equivalent profile directory/volume and secure deletion after expiry. Browserd must not share a default Chromium profile between users, machines, tabs, or test runs.

### 6.3 SSRF and egress policy

A remote browser intentionally has web egress, so URL validation alone cannot be called SSRF protection. The policy must protect **all** Chromium requests: initial navigation, redirects, subresources, iframes, fetch/XHR, WebSockets, Service Workers, prefetches, DNS rebinding, and any browser feature that can create a network connection.

The default policy is **public web**, meaning `http`/`https` and secure WebSocket traffic to DNS-resolved public addresses only. It is an allowlist of public address space, not permission to access the target machine's LAN. A stricter **domain allowlist** mode permits only exact domains and documented `*.example.com` subdomain patterns, still requiring every resolved address to be public. Literal IP navigation is blocked in domain-allowlist mode unless a separately reviewed policy explicitly permits it.

The policy must reject, at minimum:

- `localhost`, loopback IPv4/IPv6, unspecified addresses, Unix sockets, `file:`, `chrome:`, `devtools:`, `data:` initial navigations, extensions, and custom schemes;
- RFC1918, carrier-grade NAT, link-local, multicast, documentation/reserved, IPv6 unique-local/link-local, and cloud metadata addresses such as `169.254.169.254` and metadata host aliases;
- userinfo URLs, proxy environment variables, uncontrolled DNS resolvers, and non-approved destination ports;
- direct peer-to-peer WebRTC UDP/local-address discovery. WebRTC is disabled in v1 unless routed through a separately reviewed egress implementation.

Enforcement is layered:

1. **Pure policy module:** canonicalizes URL/IDNA host input, limits size, validates scheme/port, resolves using a controlled resolver, and returns an explainable allow/block decision.
2. **Chromium request interception:** applies policy at navigation and known request events and prevents user-controlled proxy configuration.
3. **Network boundary:** browserd runs in a network namespace/container with no route to host/private networks. An egress firewall/proxy rechecks DNS and destination addresses on each connection and permits only approved protocols/ports. This is the authoritative defense against renderer behavior and DNS rebinding.
4. **Operations:** health/readiness fails if the enforced egress path cannot be verified. An application-level domain list without network isolation is insufficient.

Private/internal browsing is not a normal configuration toggle. If a future product needs it, it requires a separate privileged deployment profile, explicit CIDR/domain policy, a security review, and a clear ownership/audit model; it is out of scope here.

### 6.4 Renderer and host isolation

`browserd` must be run as a separate unprivileged service account or a dedicated container identity. Production deployments require all of the following:

- Chromium's normal sandbox enabled; never use `--no-sandbox`.
- No workspace, repository, Pi profile, session archive, SSH-agent, Docker socket, hostexec helper, or general user-home mount in the browserd container/namespace.
- Read-only application root where practical, a small writable browser-profile volume/tmpfs, `no-new-privileges`, dropped Linux capabilities, seccomp/AppArmor/SELinux profile, PID/memory/CPU limits, and a bounded process count.
- A private Unix socket with restrictive owner/group permissions, or a mutually authenticated private service link. No browserd or CDP port is published to a LAN or the Internet.
- Peer credential verification and a rotating web-to-browserd service credential on the private channel; browserd accepts requests only from the authorized PI WEBUI web/API identity.
- Downloads, uploads, clipboard, sensors, notifications, and external protocol handlers disabled until each has an independent safe data-flow design.

For a native user-service installation where per-service OS identities are weak, the supported arbitrary-site mode should use an isolated container or equivalent OS sandbox. A convenience in-process Chromium launch is not an acceptable production substitute.

### 6.5 CSP, framing, and browser restrictions

The remote browser path has a strong content boundary:

- destination HTML/JS runs only inside Chromium;
- PI WEBUI renders encoded pixels, not destination markup;
- PI WEBUI CSP only needs same-origin API/WebSocket and local frame/image support; it does not need broad `frame-src` permission for arbitrary websites;
- `X-Frame-Options` and CSP `frame-ancestors` remain intact. They do not block a normal top-level Chromium page, so no header rewrite is needed;
- ordinary browser CSP, same-origin policy, TLS errors, cookie policy, and site bot-detection rules remain in force. Do not use `--disable-web-security`, stealth/anti-detection tooling, or response rewriting.

This explains both the Google case and the limits of the promise: a site can work in an ordinary browser context without PI WEBUI claiming to defeat any site-imposed restriction.

### 6.6 Privacy and logging

Remote browsing changes where a site observes the user. The UI must show the selected machine name and warn that the destination sees that machine's IP address, network region, Chromium user agent, locale/time zone, and any normal browser fingerprinting data. The gateway and target-machine operators can observe the control stream and pixels. Users should not enter credentials on an untrusted gateway or target machine.

Privacy defaults:

- no Chromium sync/sign-in, crash-upload, background component download, or undisclosed telemetry;
- no saved screenshots, page HTML, HAR, destination request/response bodies, cookies, or keystroke content in logs;
- operational logs record only safe event type, hashed/opaque subject/session/tab IDs, target machine, redacted origin or policy category, latency, resource usage, and correlation ID;
- frame buffers remain in memory and are dropped under backpressure; crash artifacts are disabled or access-controlled and scrubbed;
- ephemeral browsing data is deleted on termination/expiry.

Safe Browsing or comparable URL-reputation checks, if later enabled, need an explicit product/privacy decision because they may disclose URL information to a third party.

### 6.7 Threat table

| Threat | Primary controls | Residual risk |
| --- | --- | --- |
| A malicious website exploits Chromium or renderer code | Chromium sandbox, dedicated identity/container, no sensitive mounts, patch cadence, cgroups, no CDP exposure. | Browser exploits remain high impact; feature is opt-in and requires prompt patching. |
| A typed URL becomes SSRF to target-machine/private services | Public-address policy, connection-time DNS rechecks, restricted network namespace/egress firewall, WebRTC disabled. | Public websites can still make their own server-side requests; that is outside PI WEBUI's network. |
| A redirect, subresource, or DNS rebinding bypasses initial URL validation | Enforcement on every Chromium connection plus network boundary. | Bugs require regression fixtures and defense in depth. |
| A user or plugin attaches to another user's browser | Server-derived principal, owner-bound opaque IDs, lease generation, authorization at HTTP and WebSocket edges. | Trusted PI WEBUI-origin plugin code can act with its granted user's authority. |
| A gateway forwards its cookies or destination cookies to a remote machine | Dedicated delegation envelope; no cookie/authorization header forwarding; browser profile never leaves browserd. | Gateway/target operators are trusted infrastructure by definition. |
| A page steals PI WebUI data through DOM/XSS | No destination markup is hosted at PI WEBUI origin; no proxy/rewrite path. | Existing PI WEBUI/plugin-origin vulnerabilities remain separate risks. |
| A page causes resource exhaustion via tabs, animation, or frames | Session/tab/process limits, frame dropping, viewport caps, CPU/memory quotas, idle expiry, popup confirmation. | A permitted tab can still consume its allocated budget. |
| A user is phished or a site rejects remote/headless browsing | Visible origin/security state, external-browser escape hatch, honest error UX, no automation evasion. | Product cannot determine site legitimacy or override site policy. |

## 7. Operations and deployment design

This section specifies a future operating model; it does not install, publish, restart, or deploy anything in this change.

### 7.1 Lifecycle

`browserd` is an optional third runtime with an independent lifecycle:

- it may be started before or after the web/API process; the web/API process degrades the browser feature when it is absent instead of failing all PI WEBUI routes;
- it has no dependency on `sessiond` and no access to the session daemon socket;
- the web/API process can restart/reload independently and reconnect to a healthy browserd;
- browserd restart affects only browser sessions and produces an explicit browser-only event;
- the existing `pi-webui-sessiond.service` and split dev ownership remain unchanged.

The existing runtime/status contracts currently model `web` and `sessiond`. Browser capability readiness should initially be surfaced as a web-owned optional capability plus the browser-capabilities endpoint, rather than falsely reporting that `sessiond` owns Chromium. A later status-model expansion can add a first-class browserd component only with rolling-compatibility parsing and UI support.

### 7.2 Supported deployment shapes

| Shape | Required browserd placement | Notes |
| --- | --- | --- |
| Production container deployment | Separate browserd sidecar/container with a private control network/socket, profile volume only, and an egress-restricted network namespace. | Do not publish a browserd port or mount the existing broad `/data` volume wholesale. Browserd must not inherit the web/sessiond container's Docker/socket privileges. |
| Native service deployment | Separate service/container under dedicated unprivileged identity, private socket, OS sandbox, and enforced outbound firewall. | If the OS cannot isolate it appropriately, arbitrary-site mode stays unavailable. |
| Split development services | A separate manually managed browserd development process/container, never a child killed by the autoreloading UI/API process. | It may be disposable, but must not affect `pi-webui-sessiond` or active Pi sessions. |
| Remote machine federation | One browserd per target runtime. The gateway proxies only fixed browser routes with delegation. | The target machine owns browsing data and egress; no browser migration across machines. |

### 7.3 Dependencies, health, and observability

A release must pin the Chromium/CDP compatibility pair and include a CVE/update plan. The runtime must not download arbitrary Chromium binaries or execute a browser command supplied from configuration. Its readiness check verifies the private control channel, Chromium sandbox, policy load, egress enforcement, profile storage permissions, and protocol-version compatibility without navigating an external website.

Useful privacy-preserving operational signals are active contexts/tabs, process count, memory/CPU pressure, frame byte rate/drop rate, stream reconnects, policy-deny counts by category, Chromium crash count, and browserd protocol mismatch. They must not include page content, cookie values, typed text, or full query strings.

Resource defaults should be conservative and configurable only by an authorized machine administrator: proposed maximum two browser sessions per principal, ten tabs per session, a bounded viewport, bounded input/message sizes, 30-minute idle expiry, and per-worker CPU/memory/PID cgroups. Exceeding a limit returns a typed error and never takes down the PI session runtime.

### 7.4 Configuration and storage

Future core configuration belongs in the selected machine's global PI WEBUI config, not in a new per-feature project file and not in `$PI_WEBUI_DATA_DIR`. A proposed shape is:

```json
{
  "browser": {
    "enabled": false,
    "profileMode": "ephemeral",
    "maxTabsPerSession": 10,
    "idleTimeoutMinutes": 30,
    "egress": {
      "mode": "public-web",
      "allowedDomains": [],
      "allowedPorts": [80, 443]
    }
  }
}
```

`domain-allowlist` is the stricter alternative to `public-web`. No ordinary UI/config key may enable private-network browsing. Broker socket location, deployment credential, pinned browser binary, and egress-network plumbing are process/deployment secrets, not user-editable JSON settings.

The `browser` key should be added to the selected-machine configuration allowlist because policy is enforced where Chromium runs. It should not be project-local: browser egress and cookie isolation are machine/security policy, not workspace behavior. Browser profiles, caches, and opaque state live under a private browserd-managed area of `$PI_WEBUI_DATA_DIR` or its isolated volume, with permissions stricter than ordinary project metadata.

Changing browser policy must take effect through a controlled browserd reload/restart and be visible in readiness. It never requires a `sessiond` restart.

## 8. User experience and failure behavior

The browser panel should clearly distinguish two modes:

1. **Lightweight embedded viewer** — the current iframe behavior, with its documented frame-protection and mixed-content limitations.
2. **Remote browser on _Selected Machine_** — available only when capability, identity, browserd readiness, and policy all pass.

The remote mode displays the selected machine, profile mode (`Ephemeral`), destination origin/security state, active tab count, and a compact privacy notice. It uses server-authoritative URL/title/history state, real page zoom, tabs, reload, back/forward, stop, and explicit close. Switching machines detaches the current stream and does not move tabs, cookies, or profiles; the user opens a separate browser session on the newly selected machine.

| Condition | UI behavior | Safety property |
| --- | --- | --- |
| Browserd unavailable, sandbox unhealthy, or no authenticated principal | Explain why remote browsing is unavailable; retain lightweight viewer/external-browser link. | No unsafe best-effort browser launch. |
| Remote machine offline or lacks delegation/capability | Show target name and reconnect/choose-machine action; do not fall back to gateway browsing. | Preserves selected-machine semantics. |
| Egress policy blocks a URL/redirect/resource | Show blocked host/category and policy explanation without revealing sensitive resolved IPs; allow editing only for authorized administrators. | Does not turn a block into a retry-through-proxy. |
| Stream temporarily disconnects | Freeze most recent frame, disable input, reconnect while lease is valid. | Avoids queued/stale clicks reaching a changed page. |
| Session expires, browser crashes, or browserd restarts | Explain that only the ephemeral browser session ended; offer a new empty remote browser. | Pi sessions/terminals remain untouched. |
| Site needs CAPTCHA, passkey/WebAuthn, local device, or rejects automation | State that the site requires a normal/local browser; offer `noopener,noreferrer` external open. | No bypass or deceptive support claim. |
| Site shows TLS/network/browser error | Render the normal Chromium error page plus safe PI WEBUI status/retry control. | Browser policy remains visible. |
| Resource/tab limit reached | State the relevant limit and offer close-tab/session actions. | No unbounded allocation. |

The raster stream is not inherently semantic for assistive technology. The initial release must document this accessibility limitation and retain the external-browser escape hatch. A later accessibility plan would need a separately secured, sanitized semantic accessibility-tree protocol; it must not expose arbitrary DOM wholesale to PI WEBUI.

## 9. Implementation boundaries and test seams

The following are planned boundaries, not files changed by this document:

| Boundary | Responsibility | Test seam |
| --- | --- | --- |
| `BrowserPolicy` | URL parsing, egress decision, host/address classification, limits, redacted audit data. | Inject DNS resolver, clock, public-address classifier, and policy fixture; pure unit tests. |
| `BrowserRuntimeClient` | Small interface used by Fastify routes: create, snapshot, mutate, attach stream, terminate, health. | Fake runtime for route/component tests. |
| `BrowserdSessionService` | Authoritative owner/session/tab/profile lifecycle, quotas, lease cleanup, and event projection. | Inject worker factory, storage, scheduler, and policy. |
| `ChromiumAdapter` | Launches pinned Chromium over a pipe; translates only necessary typed operations to CDP. | Fake CDP transport; never exported to routes or plugins. |
| `BrowserStreamProtocol` | Frame envelope, input validation, backpressure, generation/lease checks. | Deterministic protocol fixture tests. |
| Web/API browser routes | AuthN/AuthZ, selected-machine lookup, error mapping, app-relative route contracts. | Fastify injection tests with fake principal/runtime. |
| Machine browser proxy | Fixed federated route list and delegation verification/forwarding. | Fake remote machine client and token verifier; ensure headers/cookies are not propagated. |
| Browser panel/client controller | Selected-machine capability state, reconnect, canvas input mapping, failure UI, tabs, real zoom. | Component/controller tests with a fake stream; no live Chromium required. |

Likely future touched areas include `src/shared/apiTypes.ts`, `src/shared/capabilities.ts`, `src/shared/federatedRoutes.ts`, `src/server/app.ts`, new `src/server/browser/` and `src/browserd/` modules, machine proxy/client routes, config parsing/routes, `src/client/src/api/`, and `BrowserPanel.ts`. These are planning targets only. The client must continue the repository's app-relative URL convention and route dynamic path segments through `encodeURIComponent`.

## 10. Verification and acceptance criteria

Implementation is acceptable only when all criteria below are met. Tests should follow the repository's smallest-layer-first approach: pure policy/service tests, Fastify route contracts, stream tests, client component tests, then isolated Chromium/container integration tests.

### Functional criteria

- A controlled test site returning both `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'` displays in the remote Chromium path without modifying those headers, while the current iframe path remains correctly documented as blocked.
- A normal top-level navigation to `https://www.google.com/` is attempted through Chromium rather than an iframe or rewritten proxy. The test suite must not promise a stable Google result; CAPTCHA, bot detection, regional behavior, and terms remain site-controlled.
- Address state follows committed redirects/navigation, tabs remain server authoritative, popups require explicit user action, back/forward/reload/stop work, and zoom changes browser-engine page zoom rather than only local raster scaling.
- The remote browser panel is scoped to the selected machine. Switching machines never copies tabs, cookies, profiles, or egress identity.
- Browser disconnect/reconnect and web/API restart preserve a valid browserd lease when it has not expired. Browserd failure affects only the browser panel; active Pi sessions survive unchanged.

### Security criteria

- No route fetches an arbitrary user-supplied website through Fastify, the gateway, or the existing machine proxy.
- Initial URLs, redirects, subresources, WebSockets, Service Workers, DNS rebinding fixtures, IPv4/IPv6 loopback, RFC1918/unique-local, link-local, metadata, and non-approved ports are blocked according to policy. The integration test proves the network boundary, not only a TypeScript URL check.
- Chromium has no public debugging port and rejects unsafe launch flags. Readiness fails when its sandbox or egress enforcement is absent.
- Browserd has no Pi/session/workspace/Docker/hostexec mounts or credentials; tests/inspection validate identity, mounts, capabilities, and private control-channel permissions.
- Cross-principal and cross-machine attach/control attempts return `BROWSER_FORBIDDEN`. Stale lease/input messages cannot affect a replacement browser context.
- Destination cookies and PI WEBUI cookies do not appear in API payloads, federation headers, logs, telemetry, snapshots, or frame metadata. Ephemeral profiles are deleted on close/expiry.
- Remote browser requests require valid delegation; expired, replayed, wrong-audience, or missing delegation fails closed. Existing filtered cookie/authorization forwarding behavior is not relaxed.
- No external website markup is inserted into the PI WEBUI DOM, and no implementation disables web security or rewrites framing/CSP headers.

### Quality and operations criteria

- New pure policy, protocol, and lifecycle logic has focused unit tests; route/proxy behavior has Fastify contract tests; browser panel behavior has component-boundary tests; new implementation meets the Programmer role's minimum 80% coverage expectation.
- Stream backpressure is bounded and drops stale frames rather than growing queues. Quota, idle cleanup, process crash, remote timeout, and browserd unavailable paths are tested.
- Capability negotiation works during rolling upgrades: unsupported/older local or remote peers hide remote mode instead of producing raw errors or falling back to another machine.
- Browser health/metrics/log redaction are verified, and logs never contain cookies, typed text, HTML, screenshots, or full sensitive URLs.
- Client URLs work under a nested deployment prefix and use `resolveAppUrl()` / `resolveAppWebSocketUrl()` exactly once at the browser boundary.

## 11. Migration and rollout plan

1. **Security/design approval:** PM and Security Auditor review this architecture, especially identity derivation, remote delegation, egress isolation, and Chromium sandbox requirements. No feature flag is enabled before that approval.
2. **Broker foundation (disabled):** Add the isolated browserd/runtime interface, pure policy tests, health/readiness, ephemeral profile cleanup, and local web/API routes behind `browser.enabled: false`. Do not replace the iframe yet.
3. **Local controlled rollout:** Enable only for a small trusted local deployment with domain-allowlist mode, resource limits, container/namespace enforcement, and test fixture sites. Validate failure UX, logging redaction, and UI/API restart behavior.
4. **Client integration:** Add selected-machine capability handling and a remote-browser panel mode. Keep the current iframe explicitly labelled rather than implying it supports arbitrary sites.
5. **Remote federation rollout:** Add fixed federated routes and signed delegation only after both gateway and target support the negotiated protocol. Start with one trusted target and no profile persistence.
6. **Broader public-web opt-in:** Permit the public-web policy only after operational egress validation, observability, abuse/resource testing, documentation, and security sign-off. It remains opt-in, not an upgrade default.
7. **Deferred features:** Evaluate persistent profiles, downloads/uploads, WebAuthn, WebRTC, semantic accessibility, and internal-network browsing separately. None piggyback on initial arbitrary-site support.

Rollback is simple and safe: disable the browser capability/config, stop accepting new browser sessions, close/drain existing ephemeral contexts, and remove browserd access. It does not modify Pi session state, `sessiond`, projects, or existing iframe behavior. There is no cookie migration from the iframe viewer and no profile import from a user's local browser.

## 12. Explicit non-goals

This design does **not**:

- strip, alter, proxy around, or bypass `X-Frame-Options`, CSP `frame-ancestors`, CORS, CAPTCHA, bot detection, paywalls, WebAuthn, DRM, or any other third-party restriction;
- promise that every website, including Google, permits remote/headless Chromium interaction;
- turn PI WEBUI into an arbitrary server-side HTML proxy, a generic SSRF tool, a browser automation/evaluation API, or a remote debugging service;
- change `sessiond` ownership, protocol, lifecycle, Pi credentials, terminal ownership, or the guarantee that browser/UI restarts do not stop active Pi sessions;
- expose private networks, cloud metadata, host files, local browser cookie jars, workspaces, Pi profiles, SSH agents, Docker sockets, clipboard, camera, microphone, or user file pickers to websites in v1;
- silently move browsing from a selected remote machine to the gateway/local machine;
- add a native desktop WebView product, browser extension, deployment artifact, service installation, package publication, merge, push, or production deployment in this architecture task;
- make raster streaming a complete accessibility solution or persist browsing history/profile data by default.

## 13. Architect handoff record

| Field | Record |
| --- | --- |
| Active phase | System Architect |
| Deliverable | This System Design Document: topology, data flows, contracts, threat model, migration plan, acceptance criteria, and non-goals. |
| Inputs inspected | Current `BrowserPanel` iframe implementation/tests, FAQ browser limitations, web/API/sessiond split, machine federation proxy/client, config conventions, service/Docker topology, and application URL conventions. |
| Decision | Recommend an opt-in, isolated, selected-machine remote Chromium/browserd with streamed pixels and typed control. Reject server-side proxy/rewrite and a native WebView host for this web/remote-first product. |
| Changed files | `docs/architecture/arbitrary-embedded-browser.md` only. |
| Architect status | `pass` — no implementation or workflow gate was advanced. |
| Next permitted action | PM may review this design and, if accepted, authorize a bounded Programmer implementation handoff followed by the required independent review, security, and QA gates. |
