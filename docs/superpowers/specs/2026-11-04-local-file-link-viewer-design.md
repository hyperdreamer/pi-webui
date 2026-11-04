# Local File Link Preview — Design

- **Date:** 2026-11-04
- **Status:** approved at design review round 5 (0 blockers, 2 minor fixed); awaiting the design continuation gate
- **Topic slug:** `local-file-link-viewer`
- **PM run:** `pm-run-20261104-094415-58058ba9`
- **Delivery target:** `refs/heads/main` at `5052cba163e1a174d4db4027c22dbbc329d90bd3`

## Background

An assistant message can point at a file it just produced:

```markdown
已创建：[打开鹈鹕骑自行车的 HTML 动画](/ramdisk/pelican-bicycle.html)
```

Two independent defects make that link useless.

1. **The browser invents the machine origin.** The anchor is root-relative. The
   browser resolves it against the page origin, so the address becomes
   `http://localhost:8808/ramdisk/pelican-bicycle.html`. On a remote machine or a
   reverse-proxied subpath the same anchor resolves against the gateway, not the
   machine that owns the file. The transcript itself contains no machine URL; the
   display does.
2. **PI WEBUI serves nothing at that path.** The only static route is the built
   client. Every other unknown path falls through `setNotFoundHandler`, which returns
   `index.html`, so clicking the link renders the PI WEBUI shell at a bogus address
   instead of the file.

`file://` is not a repair. Chrome and Firefox both refuse a top-level navigation from
an `http://` page to a `file://` URL, and a file URL names the browser's disk rather
than the machine that owns the session.

The repository already has the two pieces a correct fix needs: an authorized
file-read boundary for workspace and configured external roots
(`resolveWorkspacePathAccessTarget`), and an app-relative URL convention
(`resolveAppUrl`) that survives nested deployments and machine prefixes.

## Observed evidence

- Transcript: `/home/henry/.pi/agent/sessions/--ramdisk--/2026-11-04T00-48-23-848Z_01a1a407-4b27-77f7-bea1-14643df34bd1.jsonl`
  contains `[打开鹈鹕骑自行车的 HTML 动画](/ramdisk/pelican-bicycle.html)` — a
  root-relative anchor, no origin.
- `/ramdisk` is a registered project (`~/.pi-webui/projects.json`), so the session
  folder is already a trusted workspace root.
- `src/client/src/formatting/markdown.ts` sanitizes anchors and allows only `#`,
  `/`, `http:`, `https:`, and `mailto:`; `file:` is stripped today.
- `src/server/app.ts` serves the client bundle and answers every non-API miss with
  `index.html`.

## Success criteria

1. A local file link in a transcript opens a read-only preview tab served by the
   machine that owns the session, with no machine origin in the stored message or in
   the rewritten anchor.
2. The preview works for HTML, PDF, images, and text-like files, and refuses anything
   else with a plain, explicit message.
3. A file is readable only when the Files panel would already be allowed to read it.
4. The same behavior works on a remote machine through the existing machine proxy.
5. External links (`http:`, `https:`, `mailto:`), `#` anchors, protocol-relative
   references, and app-relative navigation are unchanged. A root-absolute path
   outside the session folder with a previewable extension is treated as a file; if
   it was actually an app path, the tab shows a plain 403/404 page rather than the
   app.
6. A page on another origin — including a page a preview navigated itself to —
   cannot use PI WEBUI's HTTP actions or WebSockets.

## Goals

1. Rewrite transcript file targets to an app-relative preview URL at render time,
   without changing message text, markdown, or the markdown cache.
2. Serve those targets through a new read-only route that reuses the existing path
   access policy.
3. Present HTML and SVG safely: the document animates but gets an opaque origin and
   cannot act as PI WEBUI.
4. Keep the fix independent of agent cooperation. Existing transcripts and existing
   model behavior must start working; no new link convention is required.
5. Reject cross-origin browser actions so a navigated preview cannot read sessions,
   type into terminals, or otherwise act on PI WEBUI.

## Non-goals

- Video and audio preview.
- Byte-range requests, seeking, or partial transfer through the machine proxy.
- Changing agent prompts, skills, or model behavior.
- A general-purpose static file server, directory listings, downloads, or writes.
- Editing files from the preview tab.
- Rewriting links outside transcript-rendered markdown.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where the preview lives | A PI WEBUI route on the machine that owns the session | Works for local, LAN, nested, and remote deployments without exposing an origin |
| Trust boundary | The Files panel's existing policy: workspace-relative paths, plus absolute paths only under `pathAccess.allowedPaths` | One authorization model, already documented and tested |
| Where rewriting happens | After markdown is inserted into the DOM, not inside markdown rendering | The markdown cache is content-keyed and machine-agnostic; a resolved URL must never enter it |
| How a link is recognized | Scheme handling, workspace-prefix stripping, and a shared previewable-extension table | Deterministic and testable, with both client and server reading one table |
| HTML/SVG security | `sandbox allow-scripts` plus `connect-src 'none'` and blocked forms, frames, workers, objects, and base URLs | Animation runs; the document cannot fetch, open a WebSocket, post a form, embed, or spawn a worker |
| Sanitizer | Accept relative references, Windows drive paths, and `file:` | They must survive the attribute sanitizer before the resolver can inspect them |
| Rewrite state | Each component remembers the written target per element and always re-resolves from it | A reused element must never keep a previous workspace, machine, or disabled resolver's URL |
| Non-file URL prefixes | `//host`, relative or root-absolute `api/`, `pi-webui-plugins/`, `assets/`, and a nested app base are never files | Prevents the extension heuristic from capturing real app or external targets |
| Browser origin guard | A full-origin (scheme, host, port) check on unsafe HTTP methods and WebSocket upgrades whenever an `Origin` header is present, installed in the gateway and the session daemon | Closes the pre-existing hole a navigated preview could reach, without changing CLI clients or same-origin browsers |
| `file://` support | Accept it and rewrite it | The scheme is already used by users and models; browsers block it, PI WEBUI does not have to |

## Design

### 1. Shared previewable-type table

New module `src/shared/fileViewTypes.ts`:

```ts
export type FileViewKind = "document" | "pdf" | "image" | "text";

export function fileViewKindForPath(path: string): FileViewKind | undefined;

export const MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_VIEW_LABEL = "64 MB";
```

Extension mapping:

| Kind | Extensions |
| --- | --- |
| `document` | `.html`, `.htm`, `.svg` |
| `pdf` | `.pdf` |
| `image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.bmp`, `.ico` |
| `text` | `.txt`, `.md`, `.markdown`, `.json`, `.jsonl`, `.csv`, `.tsv`, `.log`, `.xml`, `.yaml`, `.yml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.py`, `.sh`, `.rs`, `.go`, `.java`, `.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.toml`, `.ini`, `.conf` |

Matching is case-insensitive on the final extension. The client uses this table to
decide whether a relative path is a file reference; the server uses it to choose a
content type and to reject unsupported files. Image media types continue to come from
the existing `imageMimeTypeForPath`; the shared table only classifies the kind.

### 2. Client-side target recognition

New pure module `src/client/src/transcriptFileLinks.ts`:

```ts
export interface TranscriptFileLinkContext {
  cwd: string;
  projectId: string;
  workspaceId: string;
  machineId: string;
  /** Effective application pathname resolved from BASE_URL and document.baseURI. */
  appBasePath: string;
}

export function resolveTranscriptFilePreviewUrl(
  rawTarget: string,
  context: TranscriptFileLinkContext,
): string | undefined;

export function transcriptFileLinkContext(
  sessionCwd: string | undefined,
  workspaces: readonly Workspace[],
  machineId: string,
  appBasePath: string,
): TranscriptFileLinkContext | undefined;
```

`resolveTranscriptFilePreviewUrl` algorithm, applied to one anchor `href` or image
`src` value:

1. Trim. Empty, `#fragment`, `?query`, and protocol-relative (`//host/…`) targets
   are not files. A protocol-relative target is an external resource and stays
   untouched.
2. A scheme other than `file:` terminates recognition. Windows drive-letter paths
   (`C:\…`, `C:/…`) are recognized before the scheme test.
3. `file:` targets are parsed with `new URL()`. Only `file://` with an empty or
   `localhost` authority is accepted. Its `pathname` becomes the path and its `hash`
   is kept for step 4, because the pathname alone drops the fragment. A leading slash
   before a drive letter is removed. Any other file authority is not recognized.
4. A trailing `?query` is dropped. A trailing `#fragment` is preserved and re-attached
   to the generated URL, so `report.pdf#page=3` still opens at page 3.
5. Percent-encoding is decoded when it round-trips; malformed escapes use the raw
   text.
6. A target that names the application itself is never a file. Leading `./`
   segments are stripped, then the target is rejected when its first segment is `api`,
   `pi-webui-plugins`, or `assets`, or when `appBasePath` is a non-root nested base and
   a root-absolute target lies under it. A root deployment (`appBasePath === "/"`)
   applies no base exclusion, because every root-absolute target would otherwise be
   rejected — including the motivating `/ramdisk/pelican-bicycle.html`. The namespace
   rule applies to both relative and root-absolute forms, because the repository writes
   app references without a leading slash. `appBasePath` comes from
   `new URL(viteBaseUrl, documentBaseUrl).pathname`, not from the literal `BASE_URL`,
   which is `"./"` in this repository and cannot express a nested deployment.
7. A root-absolute or drive-letter path is a candidate when either of these holds:
   - it is the session cwd itself or lies beneath `${cwd}/` — the cwd prefix is
     stripped and the remainder becomes a workspace-relative path;
   - `fileViewKindForPath` recognizes its extension.
8. A relative path is a candidate only when `fileViewKindForPath` recognizes its
   extension. It is sent workspace-relative.
9. Any other target returns `undefined`, which leaves the attribute untouched.

Comparison of the cwd prefix normalizes `\` to `/`, removes a trailing `/`, and is
case-insensitive only when the path is a Windows drive path.

`transcriptFileLinkContext` returns `undefined` when the session has no cwd or the cwd
does not equal a workspace path in the selected project. No workspace means no
rewrite and no guessing. It returns the workspace's `projectId` and `id`, the session
cwd, and the selected machine id.

### 3. Preview URL

`src/client/src/api/urls.ts` gains:

```ts
export function workspaceFileViewUrl(
  projectId: string,
  workspaceId: string,
  path: string,
  options?: { machineId?: string },
): string;
```

It builds
`api/machines/<machineId>/projects/<projectId>/workspaces/<workspaceId>/file/view?path=<path>`
with `URLSearchParams` and returns `resolveAppUrl(...)`. `machineId` defaults to
`"local"`, matching the other helpers. The resolver appends the preserved fragment
after the resolved URL.

### 4. The preview route

`src/server/workspaceExplorerRoutes.ts` registers, for both `/api` and
`/api/machines/local`:

```text
GET {prefix}/projects/:projectId/workspaces/:workspaceId/file/view?path=<path>
```

The route resolves the workspace context and effective path access exactly like the
existing `file` and `file/preview` routes, then calls a new service. The route runs on
the machine that hosts the workspace, so `pathAccess` is that machine's own
configuration. The route is read-only; there is no PUT, POST, or DELETE counterpart.
`src/shared/federatedRoutes.ts` gains the route, so the gateway proxies it to a
selected remote machine. `referrer-policy` is added to the machine proxy's
`SAFE_RESPONSE_HEADERS`; otherwise a remote preview would silently lose the header the
local route sets.

### 5. Serving contract

New module `src/server/workspaces/fileViewService.ts`:

```ts
export class FileViewError extends Error {
  readonly status: 400 | 403 | 404 | 413 | 415;
}

export interface WorkspaceFileView {
  path: string;
  kind: FileViewKind;
  mediaType: string;
  size: number;
  modifiedAt: string;
  stream: ReadStream;
}

export async function openWorkspaceFileView(
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebUiPathAccessConfig,
): Promise<WorkspaceFileView>;
```

Authorize, then open, then measure. `resolveWorkspacePathAccessTarget` returns a
canonical pathname; it does not pin an object, so the service must not stat and open
that pathname separately.

1. Resolve the authorized canonical pathname with the existing policy.
2. Open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` on POSIX. `O_NONBLOCK` makes a FIFO
   open return immediately instead of waiting for a writer, and does not change reads
   from a regular file. `O_NOFOLLOW` refuses a final component swapped to a symlink
   after authorization.
3. `fstat` the opened handle. Reject anything that is not a regular file, then apply
   the size cap to the handle's size, never to a pre-open stat.
4. On Linux, re-check containment of the opened object through `/proc/self/fd/<fd>`;
   a handle resolving outside the authorized root is closed and rejected. This catches
   a swap that completed between authorization and open.
5. Stream from that same handle with an explicit end bound: never more than the
   handle's size and never more than `MAX_FILE_VIEW_BYTES`. A file that grows while
   the response is open is truncated at the bound.
6. Do **not** advertise a fixed `Content-Length` for the mutable stream. Count the
   emitted bytes and destroy the response instead of ending it cleanly when EOF arrives
   before the measured size, when a read fails, or when the client disconnects. A
   short body that ends cleanly would otherwise leave a fixed-length client waiting
   forever, which is exactly what a file truncated after `fstat` produces.
7. Close the handle on every rejection and abort path.

| Platform | Final-component protection | Residual |
| --- | --- | --- |
| Linux | `O_NOFOLLOW`, `O_NONBLOCK`, `fstat.isFile`, `/proc/self/fd` containment | Ancestor-directory replacement |
| Other POSIX | `O_NOFOLLOW`, `O_NONBLOCK`, `fstat.isFile` | Ancestor-directory replacement |
| Windows | Pre-open `lstat` symlink rejection, then `fstat` identity (`dev` + `ino`) compared with that `lstat`; inconclusive identity fails closed | A swap completing entirely between `lstat` and open |

The service never claims the Linux guarantee on a platform that cannot provide it.
Ancestor-directory replacement remains a residual local-race risk under the
same-OS-user threat model.

| Failure | Status | Body |
| --- | --- | --- |
| `path` parameter absent or empty | 400 | `path query parameter is required` |
| path escapes the workspace, escapes an allowed root, or is a symlink escape | 403 | `PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.` |
| path does not exist | 404 | `File not found: <path>` |
| larger than 64 MB | 413 | `File is too large to preview (limit 64 MB).` |
| directory or unsupported kind | 415 | `This file type cannot be previewed in PI WEBUI.` |

Error bodies are `text/plain; charset=utf-8`. The path is reflected only as plain
text, and the response carries `X-Content-Type-Options: nosniff`.

Success responses:

| Kind | Media type | Extra headers |
| --- | --- | --- |
| `document` (`.html`, `.htm`) | `text/html; charset=utf-8` | document policy |
| `document` (`.svg`) | `image/svg+xml` | document policy |
| `pdf` | `application/pdf` | none |
| `image` | media type from `imageMimeTypeForPath` | none |
| `text` | `text/plain; charset=utf-8` | none |

Every success response sets `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff`, and `Referrer-Policy: no-referrer`. Bodies are streamed with
`handle.createReadStream` under a byte counter; no file is buffered in memory and no
fixed length is advertised. PDFs are served whole because the machine proxy does not
forward `Range`; page seeking therefore refetches the document.

#### Document policy

```text
sandbox allow-scripts;
default-src 'none';
script-src 'unsafe-inline' http: https:;
style-src 'unsafe-inline' http: https:;
img-src http: https: data: blob:;
font-src http: https: data:;
media-src http: https: data: blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
frame-src 'none';
frame-ancestors 'none';
worker-src 'none';
object-src 'none'
```

`sandbox allow-scripts` gives the document an opaque origin, so it cannot read PI
WEBUI storage or cookies or reach into the app frame. An opaque origin alone still
permits network requests, so `connect-src 'none'` is the load-bearing part: it blocks
`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and `sendBeacon`.
`form-action 'none'` blocks body-less posts, `frame-src 'none'` and `worker-src
'none'` block embedding and background execution, `base-uri 'none'` stops a `<base>`
tag from re-pointing later relative URLs, and `frame-ancestors 'none'` keeps the
preview from being framed. Inline scripts and styles run, which a self-contained
animation needs; remote scripts and styles are allowed by scheme so a generated page
that loads a library still works. Removing `sandbox`, `connect-src 'none'`, or
`form-action 'none'` is a security regression and must fail a test.

#### Self-navigation boundary

A document can always navigate its own tab; no CSP directive or sandbox flag prevents
that. Under the document policy the replacement page has no policy of its own, so it
is an ordinary page. The browser origin guard in section 7 is what rejects its API
and WebSocket attempts. The preview tab can therefore end up on another site, but
that site cannot act on PI WEBUI.

### 6. DOM rewrite boundary

`FormattedText` gains one optional injected property:

```ts
@property({ attribute: false }) resolveFileLink?: (rawTarget: string) => string | undefined;
```

`updated()` gains an `enhanceFileLinks()` step next to `enhanceCodeBlocks()`. A
per-instance `WeakMap<Element, { attribute: "href" | "src"; original: string }>`
records the written target the first time an element is seen. This matters because
Lit can reuse a rendered element: on every pass, including a re-render that reuses a
cached markdown string or switches the selected session, the pass resolves from the
recorded original, never from a URL produced by an earlier pass.

For each `a[href]` and `img[src]` in the rendered root:

1. Read the recorded entry, or record the current attribute as the original.
2. Call the resolver with that original.
3. On a match, set the attribute to the returned URL and add
   `data-file-preview="true"`.
4. On no match, restore the original attribute and remove `data-file-preview`.
5. When the component has no resolver, restore every recorded original.

The pass therefore converges after any resolver change: A → B → no resolver leaves
the original written target, never machine A's preview URL. Anchors already carry
`target="_blank" rel="noreferrer noopener"` from the sanitizer, so the preview opens
in its own tab.

The markdown cache stays untouched: it stores the original targets, and each DOM
instance is rewritten for its own workspace and machine. Two sessions in different
workspaces therefore cannot share a resolved target.

`markdown.ts`'s `isSafeUrl` must let candidates survive sanitization. It gains three
accepted forms: relative references (no scheme before the first `/`, `?`, or `#`),
Windows drive-letter paths, and the `file:` scheme. `javascript:`, `data:`, and every
other scheme remain rejected. This is a deliberate, small behavior change: a relative
link or image the sanitizer used to delete now survives. A relative target the
resolver does not recognize stays as written — the same content the author typed.

### 7. Browser origin guard

The preview can navigate its own tab to another page. That replacement page is an
ordinary website with no PI WEBUI policy, so the application itself must refuse
cross-origin browser traffic. This closes a hole that any website in the browser could
already use.

New module `src/server/http/browserOriginGuard.ts`:

```ts
export interface BrowserOriginContext {
  origin: string | undefined;
  requestOrigin: string | undefined;
  allowedOrigins: readonly string[];
}

export function isAllowedBrowserOrigin(context: BrowserOriginContext): boolean;

export function requestOriginFrom(request: FastifyRequest): string | undefined;
```

`requestOriginFrom` derives the application origin from the effective request scheme
and the `Host` header: the first `X-Forwarded-Proto` token when present, otherwise the
socket protocol, joined with `Host` and normalized through `new URL`. The forwarded
scheme only participates in matching; it never grants access on its own.

The hook is installed in **both compositions**:

- `buildApp` — the web/API gateway, including `/api` and `/api/machines/local`.
- the session daemon's own Fastify app in `src/server/sessiond.ts`, because a TCP
  `sessiond.host` exposes the same session and terminal routes directly. Daemon callers
  are server clients and send no `Origin`.

It applies to every unsafe HTTP method (`POST`, `PUT`, `PATCH`, `DELETE`) and every
request carrying `Upgrade: websocket`.

1. An absent `Origin` is allowed. Non-browser clients send none, and a visited page
   cannot suppress it.
2. `Origin: null` is rejected. It denotes an opaque origin: a sandboxed document or a
   `data:`/`file:` page.
3. An unparseable `Origin`, a non-`http`/`https` scheme, or an origin with credentials
   is rejected.
4. The origin is compared as a full origin — scheme, host, and port — against the
   request origin. `http://pi.example` and `https://pi.example` are different origins
   and do not match.
5. An origin listed in the new global `allowedOrigins` config key is allowed. This is
   the explicit mechanism for a reverse proxy that rewrites `Host` or terminates TLS in
   a way the forwarded header does not describe. `allowedHosts` is the Vite dev-server
   setting and is never reused as browser-origin trust.
6. Everything else is rejected: HTTP `403` with
   `{"error":"Cross-origin request rejected"}`, and a WebSocket handshake rejected with
   HTTP `403` (no `101`, no route handler call, no upstream bridge). A close frame
   cannot be sent because no WebSocket exists at that point.

Config addition: `allowedOrigins` is an optional global array of absolute `http`/
`https` origins with no path, query, or fragment. There is no environment override.

- The shared type lives with the other global config types. The config-file loader
  parses and serializes it, and the config routes validate it. Entries are normalized
  to their serialized origin form; a path, query, fragment, credentials, or a non-http
  scheme is rejected.
- Both config response parsers (gateway and local alias) expose it, the browser
  response parser accepts it, and the settings draft preserves it, so saving an
  unrelated setting cannot drop it.
- `unset` and `[]` both mean no extra origins; clearing is an explicit empty array.
- `buildApp` and the session daemon each read their startup config snapshot, so a
  change requires restarting both processes.

Reverse-proxy guidance: list the external scheme and authority including its port, on
the machine whose browser clients use that address.

Safe `GET`/`HEAD` reads are unaffected, mirroring the browser's CORS model: a
cross-origin page cannot read a simple response body, and the unsafe methods that could
cause an action are rejected. Gateway-to-machine requests are server-to-server and
carry no browser `Origin`. One exception remains: an operator-configured machine record
can set a custom `Origin` header, and the machine client preserves configured headers.
When that configured origin differs from the remote's effective request origin, it must
appear in that remote machine's `allowedOrigins`; a configured origin equal to the
remote request origin is accepted with an empty allowlist. The machine documentation
states both cases.

Known limit: DNS rebinding — an attacker hostname resolving to the app's address —
still matches its own `Host` and `Origin`. It is a pre-existing property of the app's
host-based deployment model, not worsened by this feature, and it needs its own host
admission design.

### 8. Wiring

- `ChatView` gains `@property({ attribute: false }) resolveFileLink` and forwards it
  to every `formatted-text` it renders (message text, thinking, skill invocation, tool
  result).
- `PiWebUiApp` builds the resolver for the selected session from
  `transcriptFileLinkContext(session.cwd, state.workspaces, selectedMachineId(state),
  appBasePath)` and `resolveTranscriptFilePreviewUrl`. `appBasePath` is derived once
  from the same `AppUrlContext` that `resolveAppUrl` uses. It memoizes by session id, cwd, workspace id,
  and machine id so repeated renders reuse one function identity.
- When the context is `undefined`, `PiWebUiApp` passes `undefined` and no rewriting
  happens.

## Error handling

- Unsupported or missing files produce explicit plain-text pages. An operator can read
  the reason and act: allow the root, shrink the file, or open it in a terminal.
- A machine that is offline keeps the gateway's existing 502/504 machine error; the
  preview does not invent a second error channel.
- A resolver that throws is treated as "no match" for that element. The anchor keeps
  its written target, which is today's behavior.
- A missing `projectId`/`workspaceId` context disables rewriting rather than producing
  a guessed URL.
- A cross-origin unsafe request or socket upgrade is rejected with `403`
  (`Cross-origin request rejected`) before its handler runs. A rejected socket upgrade
  is an HTTP `403` handshake, not a WebSocket close frame. `Origin: null` is a
  rejection, not an absent header.

## Edge cases and risks

- **False positives.** A root-absolute path outside the session folder with a
  previewable extension is treated as a file. Protocol-relative targets, the `api`,
  `pi-webui-plugins`, and `assets` namespaces, and a nested application base are
  excluded first, which covers the app's own URL space. A remaining misclassification
  surfaces as a plain 403/404 page in a new tab, not as a broken transcript.
- **HTML sibling assets.** A document is served at a query URL, so a relative
  `<img src="local.png">` inside the HTML does not resolve to the sibling file. A
  self-contained page (inline styles, SVG, and scripts) renders correctly. Embedding
  sibling assets is out of scope for this version and is stated in the documentation.
- **Remote PDF seeking.** No `Range` forwarding means a remote PDF is transferred
  whole. This is a documented limitation, not a silent failure.
- **Symlink and stream bounds.** Authorization resolves the canonical path, then the
  file is opened non-blocking with `O_NOFOLLOW` on POSIX and measured with `fstat` on
  the opened handle. Linux additionally re-checks the handle through `/proc/self/fd`.
  A FIFO is rejected after `fstat` instead of blocking the open. On Windows the
  pre-open `lstat` identity is compared with `fstat`, with the documented residual
  window. A file that grows while streaming is truncated at the handle's size.
- **Reverse proxies and origins.** A proxy that preserves `Host` and sets
  `X-Forwarded-Proto` needs no change. A proxy that rewrites `Host` must list the
  public origin in `allowedOrigins`; otherwise its browser `POST`s are rejected as
  cross-origin. This is stated in the documentation.
- **DNS rebinding.** A hostile hostname that resolves to the app's address still
  matches its own `Host` and `Origin`. This is unchanged by the feature and is
  documented as a residual app-wide property, not claimed as covered.
- **Large output.** 64 MB cap, streamed, `no-store`; no buffering.
- **Serving user-authored HTML.** The document policy prevents the page from reading
  app state or making network requests. It may still load remote scripts and images,
  which is normal browser behavior for a document the operator asked to open. The
  page's own content is the operator's own file.
- **Windows hosts.** Drive-letter targets are recognized, and cwd prefix comparison is
  case-insensitive there.
- **File rewritten or removed after render.** The next click reports 404; no stale
  bytes are cached.
- **Element reuse.** The recorded original target makes re-resolution idempotent when
  Lit keeps an element across renders, and restoration is exact when the resolver
  disappears.

## Invariants to preserve

1. The markdown cache never contains a resolved preview URL.
2. The reference built by the client is application-relative
   (`api/machines/<machine>/...?path=...`) and is resolved exactly once by
   `resolveAppUrl` at the browser boundary. A rewritten attribute may carry the
   browser's current application origin, and must never embed a remote machine's
   configured origin, a hard-coded host, or a hard-coded port.
3. Every dynamic segment is `encodeURIComponent`-encoded and every query value is
   encoded through `URLSearchParams`.
4. Route authorization is identical to the Files panel's authorization.
5. The preview route is read-only and has no mutation counterpart.
6. External links, `#` anchors, protocol-relative references, and app-relative
   navigation keep their current behavior.
7. Document responses carry the full policy: `sandbox allow-scripts`,
   `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-src 'none'`,
   `frame-ancestors 'none'`, `worker-src 'none'`, and `object-src 'none'`.
8. No element keeps a preview URL after its resolver is removed or replaced with one
   that does not match.
9. Every unsafe browser request and WebSocket upgrade that carries a foreign or null
   `Origin` is rejected before its handler runs, in both the gateway and the session
   daemon. Origin matching compares scheme, host, and port; `allowedOrigins` is the
   only allowlist.

## Test strategy

Layer by layer, following the repository testing guide.

1. `src/shared/fileViewTypes.test.ts` — kinds for every listed extension, case
   insensitivity, unknown extensions, and every shared image extension resolving
   through `imageMimeTypeForPath`. It does not assert set equality, because the
   existing image map also classifies `.svg` for `<img>` previews.
2. `src/client/src/transcriptFileLinks.test.ts` — a table of recognition cases: root
   absolute, cwd prefix stripping and near-prefix rejection (`/ramdisk2`), relative
   with and without a previewable extension, `file://` with empty and `localhost`
   authority, malformed percent escapes, Windows drive paths, query dropping, fragment
   preservation, `http:`/`https:`/`mailto:`/`#` rejection, `//cdn…` rejection,
   `api/`/`pi-webui-plugins/`/`assets/` namespace rejection, nested-base rejection,
   and the missing-context case. `transcriptFileLinkContext` is covered against
   matching and non-matching workspaces.
3. `src/client/src/formatting/markdown.test.ts` — sanitizer survival: relative links
   and images, Windows drive paths, and `file:` keep their attribute; `javascript:`,
   `data:`, and `vbscript:` do not. This is the regression that makes recognition
   possible at all.
4. `src/client/src/api/urls.test.ts` — the expected browser-ready absolute URL, not
   an app-relative string: encoded segments, machine prefix, and nested base resolution.
5. `src/server/workspaces/fileViewService.test.ts` — a temporary workspace with
   HTML, SVG, PDF, PNG, text, unknown, oversized, directory, and FIFO fixtures;
   assertions for kind, media type, streamed bytes, 403 outside the workspace,
   allowed-root absolute read, 404, 413, 415, and the 400 for a missing `path`. A FIFO
   without a writer must be rejected promptly instead of blocking the open. Independent
   cases cover: an in-root final-component symlink swapped after authorization fails
   `O_NOFOLLOW`; an opened handle outside the root fails the Linux `/proc` containment
   check; a containment lookup failure fails closed; the pathname is replaced after
   open and the response still streams the pinned handle; a file grown after `fstat`
   stops at the handle's size; a file truncated after `fstat`, including to zero,
   destroys the response instead of ending cleanly; and every post-open rejection and
   client disconnect closes the handle. Each case must fail when its guard is removed.
   The Windows identity fallback is covered through the same seam.
6. `src/server/workspaceExplorerRoutes.test.ts` — route-level headers: content type,
   the expected document policy written out independently of the production constant
   (not imported from it), `nosniff`, `no-store`, `Referrer-Policy: no-referrer`,
   plain-text error bodies, and the `/api/machines/local` registration behaving like
   `/api`. A weakened or removed directive fails this test.
7. `src/shared/federatedRoutes.test.ts` — the new route is present in the federated
   contract so remote machines proxy it. A non-local proxy test using the existing
   remote-proxy harness asserts the body and every required header, including
   `Referrer-Policy`, survives forwarding.
8. `src/client/src/components/FormattedText.test.ts` — a real DOM render with a
   resolver rewrites anchor `href` and image `src`, marks `data-file-preview`, leaves
   external links alone, and two renders that reuse one cached markdown string resolve
   differently for two workspaces. One test walks the same element through resolver
   A → resolver B → a resolver that returns `undefined` → no resolver, asserting the
   original written target is restored at each non-matching step. The
   `undefined`-returning step is required, because a missing restoration branch would
   otherwise survive.
9. `src/client/src/components/ChatView` boundary test — parameterized over every
   `formatted-text` render site (queued text, message text, thinking, skill invocation,
   tool result). Removing any single forwarding site fails one case.
10. A `PiWebUiApp` boundary test — render with a selected session, workspace, and
    machine; read the `resolveFileLink` property from the rendered `chat-view` and
    invoke it; assert the machine, project, workspace, path, and `appBasePath` in the
    resulting URL, and `undefined` for a cwd that matches no workspace. Removing the
    app binding or forcing `"local"` fails this test.
11. `src/server/http/browserOriginGuard.test.ts` — the pure predicate. Accepts the
    exact request origin (including a forwarded `https` scheme) and an exact
    `allowedOrigins` entry. Rejects a different scheme with the same host, a different
    host, a different port, `null`, malformed values, credentials in the origin, and a
    non-http scheme. `requestOriginFrom` is covered with and without
    `X-Forwarded-Proto`.
12. `src/server/app.originGuard.test.ts` — the gateway boundary. A counting route
    handler proves the rejection happens before it runs. All four unsafe methods are
    covered on both `/api` and `/api/machines/local`, plus a non-local machine proxy
    path through the existing harness. Cases per method: same-origin allowed, foreign
    rejected, `null` rejected, malformed rejected, absent allowed, and safe `GET`
    unaffected. The socket matrix covers every family (`/events`, `/sessions/events`,
    `/sessions/:id/events`, and both terminal bridge routes) on both aliases with
    matching, foreign, `null`, malformed, and absent origins, asserting HTTP `403`, no
    `101`, zero route calls, and zero upstream bridges on rejection. Removing the hook,
    dropping one method, or special-casing `null` for upgrades fails a named case.
13. `src/server/sessiond` daemon-boundary test — builds the daemon app with a fake
    runtime and proves the same guard protects the daemon's own session and terminal
    routes: all four unsafe methods rejected for a foreign or `null` origin before the
    fake service, absent and same-origin allowed, and every daemon socket family
    rejected for foreign/`null`/malformed origins with no upstream connection. A
    two-hop case proves ordinary absent-Origin gateway-to-daemon traffic still works.
14. `src/server/configRoutes.test.ts` and the config-file tests — `allowedOrigins`
    round-trips through the file loader/serializer, accepts and normalizes absolute
    `http`/`https` origins, rejects paths, queries, fragments, credentials, and
    non-http schemes, fails closed on an invalid file value, survives an unrelated
    settings save, is exposed by both config response parsers and accepted by the
    browser parser, and is preserved by the settings draft. An activation test shows
    both compositions read the startup snapshot.
15. `src/server/machines` — a configured machine header `Origin` still reaches the
    remote. A configured origin equal to the remote request origin is accepted with an
    empty allowlist; a configured foreign origin is rejected unless it is listed in
    that remote machine's `allowedOrigins`. The default machine client still sends no
    `Origin`.
16. Audit evidence, not a Vitest case: a headless Chromium probe with a counting mock
    server proves the effective restrictions, not just rejected promises. It loads a
    fixture HTML through the preview route and records (a) animation progress,
    (b) zero requests and zero upgrades reaching the mock API, with a positive control
    showing the same attempt does reach the mock when the policy is weakened, and
    (c) a navigation to a foreign page whose API and socket attempts are rejected by
    the origin guard. The script and output are archived with the audit report.

Checks: `npm test -- --run <changed test files>`, `npm run typecheck`, `npx eslint` on
changed files, then `npm run verify:fast` before handoff.

## Documentation plan

- `docs/config.md` — extend **External path access** with the user-visible rule: local
  file links in transcripts open a read-only preview only for files inside the
  selected workspace or a configured external root, and the preview is served by the
  machine that owns the session. State the supported categories (HTML/SVG, PDF, images,
  text), the 64 MB limit, that HTML sibling assets are not resolved, and that a remote
  PDF is transferred whole.
- `docs/config.md` — document the new global `allowedOrigins` key and add its
  configuration-matrix row (scope, JSON key, env var if any, restart behavior). State
  that browser `POST`/`PUT`/`PATCH`/`DELETE` and WebSocket upgrades must come from the
  app's own origin, that `allowedHosts` is dev-server only, and that a proxy which
  rewrites `Host` must list the public origin in `allowedOrigins`.
- `docs/config.html` — the same sentences, kept synchronized with the Markdown page.
- `docs/machines.html` — state that a custom `Origin` header on a machine record must
  be listed in that remote machine's `allowedOrigins` when it differs from the remote
  request origin, and that the remote machine must be restarted after the change.
- No README change: this does not alter the shortest install path or the product
  identity.
- A `minor` changeset: file links in assistant messages now open a real preview,
  including on remote machines; cross-origin browser actions are rejected; the
  `allowedOrigins` config key is added for reverse-proxy deployments.
- The delivery summary records that the session daemon must be restarted manually,
  because the guard is also installed in that process.

## Out of scope

- Range requests, PDF seeking, and HTTP `HEAD` negotiation beyond Fastify's default.
- Video/audio preview.
- A download button, directory browsing, or preview of unsupported binaries.
- Agent-facing instructions about link formatting.
- Rewriting links outside `FormattedText` (for example plugin-rendered HTML).
- HTML sibling-asset resolution (relative `<img>`/`<script>` inside a previewed page).
- DNS-rebinding defense beyond the existing `allowedHosts` setting.
- Authentication or per-user authorization for PI WEBUI itself.
