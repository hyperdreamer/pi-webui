# Local File Link Preview — Technical Specification

- Date: 2026-11-04
- Status: implementation specification derived from the approved design; no implementation is included.
- Approved source: [Local File Link Preview — Design](2026-11-04-local-file-link-viewer-design.md), approved at design review round 5.
- Repository baseline inspected: `f9d2cb170f763c856d7869bdeb53399c8b4ad191` in the integration worktree for `pm-run-20261104-094415-58058ba9`.
- Scope: transcript link recognition and DOM rewriting, a workspace-authorized read-only file view, federation, browser origin enforcement in both HTTP compositions, config round-trip, tests, operator documentation, and one minor Changeset.

The words **must**, **must not**, and **exact** describe acceptance requirements. Paths below are relative to the repository root unless stated otherwise. This specification resolves implementation details left open by the design; it does not replace or edit that design.

## 1. Outcome and invariants

A rendered transcript target such as `/ramdisk/pelican-bicycle.html`, for a session whose cwd is `/ramdisk`, becomes a browser URL for the selected machine's workspace file-view endpoint with `path=pelican-bicycle.html`. Stored messages, Markdown source, and the content-keyed Markdown cache retain the written target. Preview bytes come from the machine that owns the workspace, through the existing gateway when it is remote.

The following invariants apply throughout the implementation:

1. Client-owned application references begin with `api/`, never `/api/`. Every machine/project/workspace segment uses `encodeURIComponent`. Query serialization uses `URLSearchParams`. A DOM-ready URL is resolved exactly once through `resolveAppUrl`; no configured remote `baseUrl`, host, or port enters a transcript resolver.
2. Only `FormattedText` enhances links. External URLs, protocol-relative URLs, anchors, query-only navigation, application namespaces, and nested application navigation remain as written.
3. Files use `resolveWorkspacePathAccessTarget` and the same effective global-plus-project path-access configuration as the Files panel. Client recognition is not authorization. No new roots or permissions are inferred from a URL.
4. Authorization resolves a name; open pins a handle; `fstat` measures that handle; reads use that handle. A second pathname-based stream is forbidden.
5. A successful mutable file stream has no fixed `Content-Length`. Growth is bounded; early EOF and read failure abort the HTTP response. Every acquired handle is eventually closed.
6. HTML and SVG receive the entire document CSP specified in section 6. Other file kinds are not executed as HTML.
7. Every protected HTTP request and WebSocket upgrade is checked before its route handler, daemon call, remote lookup, or bridge runs. An absent `Origin` is allowed; a present opaque, malformed, or foreign origin is denied unless a valid exact origin is configured.
8. Both gateway and daemon pin independent startup allowlists. Saving config does not mutate either running guard.

No video/audio preview, range support, sibling-asset serving, downloads UI, file writes, transcript mutations, agent prompting changes, plugin-HTML rewriting, authentication redesign, or DNS-rebinding defense is added.

## 2. File-by-file implementation surface

### 2.1 New production modules

| File | Exact exports | Responsibility |
| --- | --- | --- |
| `src/shared/fileViewTypes.ts` | `FileViewKind`, `fileViewKindForPath`, `MAX_FILE_VIEW_BYTES`, `MAX_FILE_VIEW_LABEL` | Browser-safe extension classification and fixed cap; no Node or DOM dependencies. The extension table is private. |
| `src/shared/browserOrigins.ts` | `normalizeBrowserOrigin` | One pure, browser-safe origin validator/normalizer shared by config parsing and origin matching. No config loading or HTTP effects. |
| `src/client/src/transcriptFileLinks.ts` | `TranscriptFileLinkContext`, `resolveTranscriptFilePreviewUrl`, `transcriptFileLinkContext` | Pure recognition and workspace selection; calls the existing-style browser URL helper only after a match. No Markdown mutation or filesystem/network calls. |
| `src/server/workspaces/fileViewService.ts` | `FileViewError`, `WorkspaceFileView`, `WorkspaceFileViewOpener`, `FileViewStat`, `FileViewLstat`, `FileViewHandle`, `FileViewDependencies`, `createWorkspaceFileViewOpener`, `openWorkspaceFileView` | Authorization, platform-specific open protection, handle measurement, kind/media selection, bounded stream creation, and pre-stream cleanup. |
| `src/server/http/fileViewReply.ts` | `FILE_VIEW_DOCUMENT_CSP`, `sendWorkspaceFileView` | Success headers, streaming byte validation, HTTP abort, and reply/stream lifetime ownership. Keeps Fastify effects out of the file service. |
| `src/server/http/browserOriginGuard.ts` | `BrowserOriginContext`, `isAllowedBrowserOrigin`, `requestOriginFrom`, `registerBrowserOriginGuard` | Pure matching plus a thin root-level Fastify `onRequest` hook. No config-file reads. |
| `src/server/sessiond/sessionDaemonApp.ts` | `SessionDaemonAppOptions`, `createSessionDaemonApp` | Import-safe construction of the daemon HTTP edge: Fastify options, origin hook, and WebSocket plugin. Does not start runtime services, migrate files, listen, install signal handlers, or own sessions. |

These exports are consumed by the compositions, route modules, or tests below. Do not add barrel exports, plugin API additions, runtime capability flags, or a general DI framework.

### 2.2 Existing production files to edit

| File | Required change |
| --- | --- |
| `src/shared/apiTypes.ts` | Add optional `allowedOrigins?: string[]` to `PiWebUiConfigValues`, with a machine-global/startup-only browser trust comment. Do not add an environment-override field. |
| `src/config.ts` | Export `parseAllowedOriginsConfig`; include the key in `parsePiWebUiConfig`, `piWebUiConfigRecord`, and the known-key deletion stage of `savePiWebUiConfig`. Preserve it in effective config by the existing spread. Invalid values are fatal, unlike the intentionally tolerant model-tier/utility-model subtrees. |
| `src/server/configRoutes.ts` | Parse/normalize the key, preserve it on omitted global updates, and include it in `SELECTED_MACHINE_CONFIG_KEYS` and `pickSelectedMachineConfig`. Both gateway and selected-machine response projections retain it in `config` and `effectiveConfig`; the server-side remote response parser validates it. Keep existing redaction, coordinated persistence, patch merge, and error mapping. |
| `src/client/src/api/parsers.ts` | Add private `optionalAllowedOrigins` and use it in `parsePiWebUiConfigValues`; validate via `normalizeBrowserOrigin`. Do not silently discard malformed values. |
| `src/client/src/components/settings/settingsConfigDraft.ts` | Include a defensive copy of optional `baseConfig.allowedOrigins` in `preservedGatewayConfigRemainder`. Preserve absent versus explicit `[]`. No new Settings form control is required. |
| `src/client/src/appUrl.ts` | Export the existing `browserAppUrlContext` function; keep its implementation and URL resolution behavior. The app uses this source to derive its effective base pathname. |
| `src/client/src/api/urls.ts` | Export `workspaceFileViewUrl` as specified in section 3. Keep other URL helpers unchanged. |
| `src/client/src/formatting/markdown.ts` | Broaden private `isSafeUrl` only as specified in section 4.2. Do not put workspace context or resolved URLs in the Markdown cache. |
| `src/client/src/components/FormattedText.ts` | Add injected `resolveFileLink`, per-instance original-attribute state, and `enhanceFileLinks()` in `updated()`. Keep code-copy and math behavior. |
| `src/client/src/components/ChatView.ts` | Add injected `resolveFileLink` and forward it to all five `formatted-text` template sites listed in section 4.5. |
| `src/client/src/components/PiWebUiApp.ts` | Capture the application base pathname lazily, memoize the selected session resolver, and bind it on `chat-view` inside `renderChatView`. Select by session cwd among the selected project's `state.workspaces`, not by `selectedWorkspace` alone. |
| `src/server/workspaceExplorerRoutes.ts` | Add optional injected opener to `WorkspaceExplorerRouteOptions`; register `GET .../file/view` within the existing prefix registration; resolve workspace/effective path access, map pre-stream errors, then transfer reply ownership to `sendWorkspaceFileView`. Do not change existing `/file` or `/file/preview`. |
| `src/shared/federatedRoutes.ts` | Add exactly `{ method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/view" }` to `FEDERATED_HTTP_ROUTES`. No timeout override or new WebSocket route. |
| `src/server/machines/machineProxyRoutes.ts` | Add lowercase `referrer-policy` to `SAFE_RESPONSE_HEADERS`. Use existing streamed GET cancellation, eager header flush, and upstream error propagation. Config forwarding picks up the shared selected-machine parser/projection changes. Do not forward browser request `Origin` or `Range`. |
| `src/server/app.ts` | Read and copy the startup `effectiveConfig.allowedOrigins` once through the existing injected config service; register the root guard before all application routes. Keep the config mutation coordinator shared. |
| `src/server/sessiond.ts` | Replace inline Fastify/WebSocket edge construction with `await createSessionDaemonApp({ allowedOrigins: config.allowedOrigins ?? [], logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) })`. Keep the existing frozen environment, startup ordering, route registration callback, runtime ownership, listener, and shutdown logic. Remove imports made unused by the extraction. |

`src/server/index.ts`, `RemoteMachineClient`, the daemon client, path-policy modules, project-local config schema, and image preview behavior need no production changes. `Origin` configured on a machine record already survives the machine client's configured-header filter; protect that behavior with tests.

### 2.3 Test, audit, documentation, and release files

The exact test-file inventory and case lists are in section 10. The implementation may add file-local typed fixture helpers in those files. Reuse `src/server/app.testSupport.ts`, real `SessionEventHub`, existing fake service patterns, and `ChatView.latex.test.ts`'s DOM disclosure approach. A modification to `app.testSupport.ts` is unnecessary: startup-specific tests construct their own `buildApp` dependency objects, while the existing remote harness is used unchanged.

Add `scripts/verify-local-file-link-viewer.mjs` for the browser audit in section 11. Update only the canonical user pages and add the exact Changeset in section 12. Do not edit README, CHANGELOG, package versions, the approved design, or runtime data as part of this feature.

## 3. Exact TypeScript contracts

### 3.1 Shared kinds

`src/shared/fileViewTypes.ts` has this public surface:

```ts
export type FileViewKind = "document" | "pdf" | "image" | "text";
export const MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_VIEW_LABEL = "64 MB";
export function fileViewKindForPath(path: string): FileViewKind | undefined;
```

Its private table is typed `Readonly<Record<FileViewKind, readonly string[]>>` and contains exactly:

| Kind | Extensions |
| --- | --- |
| `document` | `.html`, `.htm`, `.svg` |
| `pdf` | `.pdf` |
| `image` | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.bmp`, `.ico` |
| `text` | `.txt`, `.md`, `.markdown`, `.json`, `.jsonl`, `.csv`, `.tsv`, `.log`, `.xml`, `.yaml`, `.yml`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.py`, `.sh`, `.rs`, `.go`, `.java`, `.c`, `.h`, `.cc`, `.cpp`, `.hpp`, `.toml`, `.ini`, `.conf` |

Split the path on both slash forms, inspect only the final non-directory leaf, and use its last dot plus suffix, lowercased. A terminal separator, no dot, a leading-dot-only name such as `.html`, or a trailing dot has no extension. Do not parse a URL or strip query/fragment here: callers provide a filesystem path. `.SVG` is `document`, even though the existing image MIME helper also knows SVG.

### 3.2 Client recognition and URL boundary

```ts
// src/client/src/transcriptFileLinks.ts
import type { Workspace } from "../../shared/apiTypes";

export interface TranscriptFileLinkContext {
  cwd: string;
  projectId: string;
  workspaceId: string;
  machineId: string;
  /** Effective application pathname from the browser AppUrlContext. */
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

// src/client/src/api/urls.ts
export function workspaceFileViewUrl(
  projectId: string,
  workspaceId: string,
  path: string,
  options?: { machineId?: string },
): string;
```

`workspaceFileViewUrl` constructs `new URLSearchParams({ path })`, creates the reference below, and calls `resolveAppUrl(reference)` exactly once:

```text
api/machines/<encodeURIComponent(machineId ?? "local")>/projects/<encodeURIComponent(projectId)>/workspaces/<encodeURIComponent(workspaceId)>/file/view?<params.toString()>
```

`path` is one query value, not a path segment; do not manually escape it before passing it to `URLSearchParams`. The return is a browser-ready absolute URL on the current application's origin and nested base. The resolver appends the retained fragment after this call; the helper itself never accepts or interprets fragments. No JSON `request()` call is involved in a DOM navigation.

Both Lit components declare exactly this optional injected property:

```ts
@property({ attribute: false })
resolveFileLink?: (rawTarget: string) => string | undefined;
```

### 3.3 File service and injection seam

```ts
// src/server/workspaces/fileViewService.ts
import type { ReadStream, Stats } from "node:fs";
import type { PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import type { FileViewKind } from "../../shared/fileViewTypes.js";
import type { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";

export class FileViewError extends Error {
  readonly status: 400 | 403 | 404 | 413 | 415;
  constructor(status: 400 | 403 | 404 | 413 | 415, message: string,
    options?: ErrorOptions);
}

export interface WorkspaceFileView {
  path: string; // policy displayPath, not the canonical target
  kind: FileViewKind;
  mediaType: string;
  size: number; // fstat byte count, also the stream's exact expected count
  modifiedAt: string; // fstat.mtime.toISOString()
  stream: ReadStream;
}

export type WorkspaceFileViewOpener = (
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebUiPathAccessConfig,
) => Promise<WorkspaceFileView>;

export type FileViewStat = Pick<Stats,
  "dev" | "ino" | "size" | "mtime" | "isFile">;
export type FileViewLstat = FileViewStat & Pick<Stats, "isSymbolicLink">;

export interface FileViewHandle {
  readonly fd: number;
  stat(): Promise<FileViewStat>;
  createReadStream(options: {
    start: number;
    end: number;
    autoClose: true;
  }): ReadStream;
  close(): Promise<void>;
}

export interface FileViewDependencies {
  platform: NodeJS.Platform;
  authorize: typeof resolveWorkspacePathAccessTarget;
  open(path: string, flags: number): Promise<FileViewHandle>;
  lstat(path: string): Promise<FileViewLstat>;
  realpath(path: string): Promise<string>;
}

export function createWorkspaceFileViewOpener(
  overrides?: Partial<FileViewDependencies>,
): WorkspaceFileViewOpener;

export async function openWorkspaceFileView(
  rootPath: string,
  path: string | undefined,
  pathAccess?: PiWebUiPathAccessConfig,
): Promise<WorkspaceFileView>;
```

Defaults are `process.platform`, the imported path authorizer, and `node:fs/promises` operations. `openWorkspaceFileView` delegates to one default opener. Constructing an opener performs no I/O. Tests override only the needed boundaries, particularly authorization-to-open swaps, platform identity metadata, and `/proc` lookup. Do not mock the complete service to prove its security guards.

`FileViewError` sets `name = "FileViewError"`; `status` and `message` are the public pre-stream error contract. Preserve an available cause with `ErrorOptions`. Unexpected infrastructure errors remain ordinary errors for the route's generic 500 translation.

Extend the existing route options, retaining their other fields:

```ts
interface WorkspaceExplorerRouteOptions {
  // Existing config, taskPathGate, and taskFiles fields remain.
  openFileView?: WorkspaceFileViewOpener;
}
```

In the existing exported interface, add the field above rather than declaring a second interface. The default is `openWorkspaceFileView`.

```ts
// src/server/http/fileViewReply.ts
import type { FastifyReply } from "fastify";
import type { WorkspaceFileView } from "../workspaces/fileViewService.js";
import type { ReplyDisconnectScope } from "./replyDisconnect.js";

export const FILE_VIEW_DOCUMENT_CSP: string;
export function sendWorkspaceFileView(
  reply: FastifyReply,
  view: WorkspaceFileView,
  disconnect: ReplyDisconnectScope,
): Promise<FastifyReply>;
```

The reply helper takes ownership of the passed stream and disconnect scope on entry, including when the reply is already disconnected. The route must not dispose that scope immediately after calling it.

### 3.4 Origin predicate, hook, and daemon edge

```ts
// src/shared/browserOrigins.ts
export function normalizeBrowserOrigin(value: string): string | undefined;

// src/server/http/browserOriginGuard.ts
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface BrowserOriginContext {
  origin: string | undefined;
  requestOrigin: string | undefined;
  allowedOrigins: readonly string[];
}

export function isAllowedBrowserOrigin(
  context: BrowserOriginContext,
): boolean;
export function requestOriginFrom(
  request: FastifyRequest,
): string | undefined;
export function registerBrowserOriginGuard(
  app: FastifyInstance,
  allowedOrigins?: readonly string[],
): void;

// src/server/sessiond/sessionDaemonApp.ts
import type { FastifyInstance, FastifyServerOptions } from "fastify";

export interface SessionDaemonAppOptions {
  allowedOrigins?: readonly string[];
  logger?: FastifyServerOptions["logger"];
  bodyLimit?: number;
}
export function createSessionDaemonApp(
  options?: SessionDaemonAppOptions,
): Promise<FastifyInstance>;
```

The factory uses the existing `sessionRouteFastifyOptions`, `logger: options.logger ?? true`, and an optional body limit. Register the root guard before route registration and await the existing `@fastify/websocket` plugin. The production `sessiond.ts` retains the register-routes callback and calls this same factory. Tests must not import the executable `sessiond.ts` or create a parallel test-only daemon composition.

### 3.5 Config additions

```ts
// Addition within src/shared/apiTypes.ts PiWebUiConfigValues:
/** Extra exact browser origins trusted by this machine; both HTTP owners restart. */
allowedOrigins?: string[];

// Addition in src/config.ts:
export function parseAllowedOriginsConfig(
  value: unknown,
  source: string,
): string[];
```

`PiWebUiConfig`, `EffectivePiWebUiConfig`, and both fields of `PiWebUiConfigResponse` inherit the new property through their existing type relationships. `PiWebUiConfigEnvOverrides` gains no property. There is no `PI_WEBUI_ALLOWED_ORIGINS` override, CLI switch, project-local key, or machine-record schema addition.

## 4. Client algorithms

### 4.1 Workspace context and path comparison

`transcriptFileLinkContext` performs these steps in order:

1. Return `undefined` if cwd or machine id is missing/empty, or `appBasePath` is not a root-absolute pathname. Whitespace inside a filesystem cwd is significant; do not trim it.
2. For comparison only, replace backslashes by `/` and remove trailing `/` characters while preserving `/` and drive roots such as `C:/`. Do not resolve `.` or `..`, consult browser location, or access the host filesystem.
3. Find the first workspace whose normalized path equals the normalized cwd. Use case-insensitive comparison only when both are drive-absolute paths matching `^[A-Za-z]:/`; all other paths compare case-sensitively.
4. Require nonempty workspace `id` and `projectId`. Return the original session cwd, that workspace's ids, supplied machine id, and supplied base pathname. Otherwise return `undefined`.

`state.workspaces` belongs to the selected project. `PiWebUiApp` must additionally filter it to `candidate.projectId === state.selectedProject.id`; no selected project means no context. Selecting a child session in another workspace in the same project still matches that session's cwd. Do not require it to equal `selectedWorkspace.path`.

### 4.2 Sanitizer survival

Keep `isSafeUrl` private. Evaluate a trimmed inspection copy but retain the original attribute value when accepted:

1. Reject ASCII control characters U+0000–U+001F or U+007F anywhere in the inspection value. This prevents a tab/newline-obfuscated active scheme from qualifying as a relative reference.
2. Accept Windows drive-absolute paths matching `^[A-Za-z]:[\\/]` before scheme recognition.
3. Accept existing `#...`, `/...`, protocol-relative, and query-only forms.
4. If a scheme matching `^[A-Za-z][A-Za-z0-9+.-]*:` is present, accept only `http:`, `https:`, `mailto:`, and `file:`, case-insensitively. Existing allowed external protocols keep their behavior. `javascript:`, `data:`, `vbscript:`, and all other schemes lose the URL attribute.
5. Otherwise accept a relative reference only when there is no colon before the first `/`, `?`, or `#` (or before end-of-string if none occurs). Thus `notes/a:b.txt` survives, but `unknown:thing` does not. Empty relative references may survive; the resolver declines them.

The existing sanitizer still escapes raw Markdown HTML, removes dangerous elements/event attributes, and supplies `target="_blank" rel="noreferrer noopener"` on anchors. Do not add `data-file-preview` to cached Markdown. Marked syntax affects how a backslash is written in Markdown: Windows/file candidate sanitizer tests use valid Markdown destinations (angle-bracket destinations or escaped backslashes) and assert the resulting DOM attribute, rather than assuming raw Markdown backslashes survive parsing.

### 4.3 Recognition precedence

`resolveTranscriptFilePreviewUrl` is synchronous. It returns `undefined` for an incomplete context (empty cwd, ids, machine id, or invalid base pathname), even if called directly instead of through the context helper.

For a valid context, perform these steps in order:

1. Trim `rawTarget`. Empty, `#...`, `?...`, and targets beginning `//` return `undefined`. A leading pair of backslashes (UNC spelling) is also declined before slash normalization. These checks occur before any filesystem heuristic.
2. Recognize a drive-absolute path (`^[A-Za-z]:[\\/]`) before a scheme. Otherwise, any explicit scheme other than case-insensitive `file:` returns `undefined`.
3. For `file:`, require the literal scheme prefix to be followed by `//`, then parse with `new URL`. Accept only an empty hostname or `localhost` (URL-normalized case), with no credentials or port. Decline a parse failure, nonlocal authority, `file:relative`, and `file:/single-slash`. Use `url.pathname`, retain `url.hash`, and discard `url.search`. Strip one leading `/` before a drive-absolute pathname. URL parsing may normalize dot segments for a `file://` URL; there is no second URL parse of the resulting filesystem path.
4. For a non-`file:` target, separate the first `#` and preserve it and everything after it verbatim as the fragment. In the part before that fragment, discard the first `?` and everything after it. `a.pdf?download=1#page=3` therefore uses path `a.pdf` and fragment `#page=3`. A literal `?` or `#` in a filename must have been percent-encoded in the written target.
5. Decode the path exactly once if its percent escapes round-trip as valid UTF-8. Concretely, `decodeURIComponent(path)` must succeed; each maximal contiguous `%HH` run must decode and re-encode to the same bytes when every UTF-8 byte is written as `%HH` (hex letter case is irrelevant). If any escape is malformed, invalid UTF-8, or fails that byte round-trip, retain the entire original path, not a partially decoded prefix. A literal `+` stays `+`. `%25` becomes `%` once; never decode a second time. The fragment is never decoded.
6. Replace backslashes in the candidate path by `/`. Strip all leading `./` segments for recognition and the eventual request path. Decline a resulting leading `//` as an unsupported UNC/protocol-relative form, including one revealed by decoding or mixed separators. Apply application exclusions before cwd stripping: remove at most the root `/` for a namespace check, and decline when the first segment is exactly `api`, `pi-webui-plugins`, or `assets` (case-sensitive). This covers `api/x.html`, `./api/x.html`, and `/api/x.html`; `apian/x.html` is not excluded. For a non-root effective application base, decline root-absolute paths equal to its slashless prefix or beneath its trailing-slash prefix. `/tools/pi/` excludes `/tools/pi/assets/x.png` and `/tools/pi/report.html`, but not `/tools/piano/a.html`. The root base `/` imposes no base exclusion. A decode that reveals these reserved namespaces is also excluded.
7. For a POSIX root-absolute or drive-absolute candidate, compare it to the cwd using section 4.1's slash/trailing-slash rules and Windows-only case folding. An exact cwd match produces workspace-relative `"."`; a child match must have a separator boundary and produces the remainder, preserving its case. `/ramdisk2/a.html` never counts as a child of `/ramdisk`. For `/` and `C:/`, handle the retained root separator once. A child with an unknown extension is still a candidate: the server returns 415 if unsupported.
8. A remaining absolute candidate is accepted only if `fileViewKindForPath` recognizes it, and is sent absolute. A remaining relative candidate is accepted only if the classifier recognizes it, and is sent relative. Do not collapse or discard `..`: `../a.html` reaches the authorization boundary and is denied. Do not support UNC paths as an additional path family.
9. Call `workspaceFileViewUrl(projectId, workspaceId, requestPath, { machineId })` and append the preserved fragment. Return `undefined` for all other cases. The pure recognition layer does not catch arbitrary URL-helper errors; `FormattedText` owns the per-element fallback if the injected resolver throws.

A path ending in `/`, the cwd itself, a missing file, or a path with a denied extension is never converted to a directory UI or another kind of app navigation. It either is declined by recognition or receives the route's explicit error.

### 4.4 DOM enhancement and restoration

`FormattedText` owns one private `WeakMap<Element, { attribute: "href" | "src"; original: string }>` for its lifetime. This state must not be global, keyed by Markdown text, or shared between elements/components.

On **every** `updated()` pass, call `enhanceFileLinks()` next to the existing code-block enhancement. For each rendered `a[href]` and `img[src]`:

1. Use `getAttribute`, never the browser-resolved `.href`/`.src` property, to obtain the written attribute. If the element has no map entry, record that exact string and the relevant attribute name.
2. Always use the recorded original for subsequent calls. Do not offer an earlier preview URL back to a later resolver.
3. If a resolver exists, call it inside a per-element `try/catch`. A thrown resolver or a return of `undefined` is a non-match for that element; one exception must not stop enhancement of its siblings.
4. On a match, set the attribute to the returned URL and set `data-file-preview="true"`.
5. On a non-match, including no resolver, restore the recorded original byte-for-byte at the DOM attribute level and remove `data-file-preview`.

All attributes remain present, so walking the current rendered nodes finds every still-live rewritten element when the resolver disappears. Replaced nodes are allowed to be garbage collected through the WeakMap. If Markdown content changes, `unsafeHTML` creates replacement nodes with their own originals. This feature installs no mutation observer and does not support another owner mutating a recorded node's written attribute in place.

Changing only the resolver is a Lit update and must run the pass even if cached HTML and element identity do not change. The live plain-text branch has no links; enhancement is a no-op until Markdown rendering resumes. Two instances rendering one cached Markdown string must resolve independently, and `toSafeMarkdownHtml` must still return the original href/src afterward.

### 4.5 Chat and app binding

Forward `.resolveFileLink=${this.resolveFileLink}` at **each** of these five `ChatView.ts` sites:

| Render site | Current content source |
| --- | --- |
| Queued message | `message.text` in the queued-message section; this template covers server and client queued messages. |
| Message text part | `part.text` for `part.type === "text"`. |
| Thinking part | `part.text` in the thinking details. |
| Skill invocation | `part.content`. |
| Tool result | `part.text`. |

User and assistant text share the message-text site. Bash's existing plain shell output is not converted to Markdown.

In `PiWebUiApp`, add a private lazy application-base field and a private one-entry resolver memo. If `document` is unavailable, the selected project is absent, or no complete workspace/cwd ownership match exists, clear the memo and bind `undefined` before reading browser URL state. During the first `renderChatView` that has that ownership and a browser document, obtain `browserAppUrlContext()` and compute `new URL(context.viteBaseUrl, context.documentBaseUrl).pathname`; retain this pathname for the document lifetime. This keeps detached/node tests from reading `document` merely by constructing the component and declines rewriting in a nonbrowser render. The repository's Vite base is `./`; inspecting that literal alone is incorrect. A nested deployment requires its existing canonical trailing slash.

Build context from the selected session's cwd, project-filtered `state.workspaces`, `selectedMachineId(state)`, and this pathname. If context is absent, clear the memo and bind `undefined`. Otherwise memoize by the tuple `[session.id, context.cwd, context.projectId, context.workspaceId, context.machineId, context.appBasePath]`. Use tuple equality or collision-free serialization, not concatenation with an ambiguous separator. Repeated renders with equal values, including newly allocated workspace objects, reuse the same function. A changed tuple creates a closure over an immutable copy of the new context. Bind that function to `.resolveFileLink` on the real `chat-view` in `renderChatView`.

Do not derive ownership from a remote machine's configured URL or from the workspace currently highlighted when it differs from the session cwd. Keep the existing app URL provider as the browser boundary; no nonbrowser hard-coded origin or root-base fallback is introduced.

## 5. File authorization, open, and streaming

### 5.1 Ordered service algorithm

`openWorkspaceFileView` and factory-created openers follow the same algorithm:

1. Reject absent or exact-empty `path` with the required 400 message. Reject a NUL-containing string with its separate 400 message. Whitespace filenames are not silently trimmed. HTTP non-string and repeated query values are rejected at the route boundary before this typed API.
2. Call `authorize(rootPath, path, pathAccess)` exactly once, using the existing policy. Retain its `root`, `target`, and `displayPath`. A relative request stays under the canonical workspace. An absolute/home-relative request requires a configured allowed root. Do not independently allow all absolute workspace paths: the client intentionally makes cwd-child paths relative.
3. On Windows only, call `lstat(target)` before opening. A final symlink is a 403. A nonregular entry is a 415. Capture dev/ino for comparison after open. Do not pre-stat size on POSIX.
4. Open the canonical target. On Linux and other POSIX hosts use numeric `constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK`; on Windows use `constants.O_RDONLY`. Constants must not be accidentally replaced by their truthiness or by string `"r"` on POSIX. A POSIX FIFO must not wait for a writer. An existing authorized symlink resolving inside a permitted root remains permitted: authorization returns its canonical destination; no-follow protects the final destination entry from a subsequent swap.
5. Inside a `try/finally` ownership region, `await handle.stat()`. Require `isFile()` before reading. Require finite, nonnegative safe-integer `size`; inconsistent metadata is a fail-closed 403. A directory/FIFO/device/socket is a 415. If size exceeds `67_108_864`, return 413; exactly that size is allowed.
6. On Windows compare the pre-open lstat identity with fstat. Both `dev` values must be finite nonnegative safe integers; both `ino` values must be finite positive safe integers. Require exact equality of dev and ino. Missing, zero-inode, unsafe, or unequal identities are inconclusive and return 403. Pre-open size is not used for the response or cap.
7. On Linux, call the injected `realpath` with the descriptor reference `/proc/self/fd/${handle.fd}`. Use `path.relative(root, openedPath)` to require equality or a child path: reject `..`, `..${sep}...`, and absolute relative results. Never use `startsWith(root)`. A lookup failure or an opened object outside the granting canonical root is a 403, even if the request pathname still looks in-root. Do not strip a ` (deleted)` suffix to guess an identity; a lookup failure for a removed object fails closed. Other POSIX hosts do not consult `/proc` and must not claim this check happened.
8. Classify `displayPath` using the shared table. Unknown kind is a 415. For HTML/HTM use `text/html; charset=utf-8`; SVG `image/svg+xml`; PDF `application/pdf`; text `text/plain; charset=utf-8`; images use `imageMimeTypeForPath(displayPath)`. If the shared image kind has no MIME result, fail closed with 415, never a generic executable MIME guess.
9. For size greater than zero, call `handle.createReadStream({ start: 0, end: Math.min(size, MAX_FILE_VIEW_BYTES) - 1, autoClose: true })`. The end is inclusive. Do not reopen the target, read it into a Buffer, or defer the measurement to the response.
10. For a measured zero-byte regular file, create the same handle-backed stream with `{ start: 0, end: 0, autoClose: true }` and push EOF (`stream.push(null)`) before returning or allowing consumption. This must perform zero reads even if the file subsequently grows; do not attempt `end: -1`. Consumption/end or explicit destruction still closes the handle through stream auto-close.
11. Return the `WorkspaceFileView` metadata and stream; transfer the handle's close ownership to that stream only after successful stream construction and zero-size setup. Until stream creation, `finally` closes the handle on **every** error. If a stream was constructed but later setup fails, destroy that stream and observe its close, which releases its handle reference; do not await `handle.close()` while leaving that stream alive. Do not independently close an already-transferred handle in the service's `finally`.

Never suppress a close failure by pretending the file was served. Preserve the primary rejection, record a cleanup failure as its cause/diagnostic where possible, and let the route log an unexpected infrastructure error. Post-transfer stream errors are handled by the reply adapter.

### 5.2 Platform contract

| Host branch | Required mechanism | Required injected proof |
| --- | --- | --- |
| Linux | No-follow + nonblocking open, handle regular-file/size checks, granting-root containment through `/proc/self/fd`. | Exact flags, final-entry swap, outside-root handle, near-prefix outside root, lookup failure, cleanup. |
| Other POSIX (`darwin` in seam tests) | Same flags and fstat checks; no `/proc` lookup. | Reject final-entry symlink/FIFO and prove no Linux-only lookup. |
| Windows (`win32` in seam tests) | Pre-open final-entry lstat, symlink rejection, then conclusive matching dev/ino and fstat size. | Equal identity accepted; each dev/ino mismatch or inconclusive identity denied; no POSIX-only flag assumption. |

These branch tests run deterministically on the normal test host through `FileViewDependencies`. Also use real temporary files and real POSIX symlink/FIFO fixtures on supporting hosts. A FIFO probe runs in a child process with a parent-owned deadline and cleanup, so deleting `O_NONBLOCK` produces a bounded failure rather than hanging Vitest. Do not run a potentially blocking `open()` on Vitest's main event loop as the only negative control.

Ancestor-directory replacement remains a residual race under the same-OS-user threat model. Windows also retains the design's documented entirely-between-lstat-and-open replacement limitation. No `openat` subsystem or new path-policy implementation is in scope.

### 5.3 Route and reply ownership

For each existing `registerWorkspaceExplorerRoutes` prefix (`/api`, `/api/machines/local`):

1. The root origin hook has already run. Validate that `query.path` is absent or one string; arrays/repeated values are invalid. Reject a missing/empty/NUL value using section 6 without resolving any workspace or opening any file.
2. Create a `createReplyDisconnectScope(reply)` before asynchronous workspace/config/file work. If it is already aborted, do no further work.
3. Resolve `resolveWorkspaceContext(projects, workspaces, projectId, workspaceId)`. Then call `pathAccessForWorkspaceContext(context, options.config)`. This reads the hosting machine's effective global/project roots on every file request.
4. After each awaited boundary, check the disconnect signal. Do not start later work for an abandoned reply. An open already in flight may finish: if so destroy its returned stream immediately and send nothing.
5. Call the injected/default opener with exactly `(context.root, path, effectivePathAccess)`. On a pre-stream error, dispose the scope and send the plain-text mapping in section 6, unless already disconnected. Log unexpected errors through the request logger, without exposing stack/config/credentials in the body.
6. On success, call and return `sendWorkspaceFileView(reply, view, disconnect)`. That helper owns disposal until terminal response/stream settlement. Do not run a route `finally` that disposes it while streaming is active.

`sendWorkspaceFileView` performs these ordered steps:

1. Attach source-error, outgoing-finish/close, and disconnect handling before starting any reads. An already disconnected reply destroys the source and disposes the scope without writing a body.
2. Set the success headers in section 6. Remove any accidentally preset `content-length`. Use a counting `Transform` between `view.stream` and the response pipeline. The transform passes Buffer chunks without accumulating the file, counts uncompressed file bytes, and rejects bytes exceeding `view.size` or the cap. Its final flush fails unless emitted bytes equal `view.size`.
3. Arm a one-shot listener on `reply.raw`'s `pipe` event, following the existing machine proxy's eager-header-flush pattern. In that listener flush final Fastify/compression-adjusted headers and **then** connect the paused source to the counter. This prevents a zero-byte truncation/read failure from becoming a clean empty response or a second Fastify error page, and preserves compression negotiation. Do not flush raw headers before Fastify has applied its final headers.
4. `reply.send(counter)` supplies the stream to Fastify. Keep source and counter errors observed. A source read error destroys counter and `reply.raw`; a counter overflow/short flush destroys source and `reply.raw`. No clean `end`, error text append, or replacement JSON is permitted after stream commitment.
5. A client disconnect destroys source and counter. `autoClose: true` closes the underlying handle. The source is also destroyed if header/send setup fails before piping, or if the outgoing response finishes while the source has not ended (notably Fastify's default bodyless HEAD path). Cleanup is idempotent: dispose the disconnect scope and release response listeners at terminal response settlement, while retaining source/counter error observation until their own close events so late filesystem errors cannot become unhandled. It must not wait for an unbounded peer action.
6. Normal completion requires exact counted bytes, a clean counter flush, and normal HTTP finish. It does not require a new pathname stat. An in-place edit of unchanged size is not a snapshot guarantee.

Before headers, ordinary file/service failures receive section 6's status. After success is committed, errors are transport failures with no replacement HTTP status. In particular, truncation to zero after fstat must cause an aborted/incomplete HTTP response, not a successful empty 200.

## 6. Exact wire and error contracts

### 6.1 Endpoint

```text
GET /api/projects/:projectId/workspaces/:workspaceId/file/view?path=<URLSearchParams value>
GET /api/machines/local/projects/:projectId/workspaces/:workspaceId/file/view?path=<value>
GET /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/file/view?path=<value>
```

The last form is gateway federation for a nonlocal machine; it forwards to that machine's `/api/projects/.../file/view` with the encoded query preserved. Dynamic route segments are decoded once by Fastify; the query is decoded once by its normal query parser. The server does **not** call `decodeURIComponent` again. Repeated `path` values are rejected rather than choosing one. Unrecognized extra query keys have no effect. Fragments never reach the server.

Only GET is registered by the feature. Fastify's default HEAD alias may run the GET logic and suppress the body; it must still release a created stream/handle. Do not add a mutation counterpart, explicit HEAD negotiation, `Range` forwarding, or a 405 handler. Other methods keep ordinary router behavior, subject to the origin guard. A Range header is ignored and a valid file returns whole-body 200, never 206/416. No preview-specific 304 or conditional cache negotiation is added.

### 6.2 Successful response

Status is `200`. The body is raw file bytes, subject to the measured bound and ordinary existing HTTP compression. Exact application-owned headers are:

| Header | Value |
| --- | --- |
| `Content-Type` | Kind-specific value below. |
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Content-Security-Policy` | The exact string below, **only** for `document`. |

| Kind/extension | Exact Content-Type |
| --- | --- |
| `.html`, `.htm` | `text/html; charset=utf-8` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.avif` | `image/avif` |
| `.bmp` | `image/bmp` |
| `.ico` | `image/x-icon` |
| All text extensions | `text/plain; charset=utf-8` |

The complete single-line document CSP is exactly:

```text
sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'
```

There is no trailing semicolon. Do not add `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-top-navigation`, `unsafe-eval`, or a permissive connect source. `sandbox allow-scripts` yields an opaque origin while animation/inline script runs. `connect-src 'none'` blocks fetch/XHR/WebSocket/EventSource/beacon; forms, frames, workers, objects, and base URLs are separately blocked. Scheme-authorized remote resources can still load; do not claim all network loads are blocked. The document may navigate its own tab. The destination page is protected by the app/daemon origin guard, not by a claim that CSP survives navigation.

No success response sets `Content-Length`, `Content-Disposition`, `Content-Range`, `Accept-Ranges`, `ETag`, or `Last-Modified`. `modifiedAt` is service metadata, not a cache validator. A measured zero-byte file still uses stream framing and no fixed length. The existing server may add Date/connection/transfer framing, and compression may add `Content-Encoding` and `Vary: Accept-Encoding`; those are transport-managed and must not change CSP or the file-byte counter.

### 6.3 Plain-text failures before stream commitment

Bodies below are exact UTF-8 text with **no terminal newline**. Every file-view error sets `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. No document CSP, download disposition, cache validator, or range header is added to an error. Fastify may calculate the accurate length of a fixed error string; the no-fixed-length prohibition applies to mutable successful file streams.

| Condition | Status | Exact body |
| --- | --- | --- |
| Absent or exact-empty `path` | 400 | `path query parameter is required` |
| Non-string or repeated `path` query value | 400 | `path query parameter must be a single string` |
| NUL in `path` | 400 | `path query parameter must not contain NUL bytes` |
| Policy denial, traversal, symlink escape/swap, read permission denial, Linux containment failure, Windows inconclusive/mismatched identity, or invalid handle size | 403 | `PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.` |
| Target absent at authorization or open | 404 | `File not found: <path>` |
| Unknown project id (`ProjectNotFoundError`) | 404 | `Project not found` |
| Unknown workspace in a known project | 404 | `Workspace not found` |
| Measured size over cap | 413 | `File is too large to preview (limit 64 MB).` |
| Nonregular target or unsupported kind/MIME | 415 | `This file type cannot be previewed in PI WEBUI.` |
| Unexpected service, project-store, config-loading, stream-construction, or metadata failure before commitment | 500 | `Unable to preview this file.` |

`<path>` is the once-query-decoded request value, with no HTML interpolation/escaping because the response is plain text. Do not reflect canonical server paths instead. The status is chosen in the algorithm's stage order, not by inspecting extension before authorization.

The file service translates these existing policy errors to 403: `Absolute paths are not allowed`, `Path traversal is not allowed`, `Path escapes workspace`, `Path is outside allowed paths`, and the prefixes `Absolute path is not valid on this host:` / `Path is not absolute:`. Node `EACCES`, `EPERM`, and `ELOOP` during authorization/open map to 403. The existing `Path does not exist` error (with optional ENOENT cause) and target-open `ENOENT`/`ENOTDIR` map to target 404. Do not map every arbitrary cause-chain ENOENT to missing target: an invalid/missing configured allowed directory or workspace root is an infrastructure/config error and maps to 500. Use the operation stage and the existing policy's specific error, not an unrestricted message substring.

Unknown workspace is currently an ordinary `Error("Workspace not found")` from `resolveWorkspaceContext`; recognize it only in that context-resolution catch. Do not rewrite the shared helper or change other explorer routes' catch-all semantics.

An offline remote retains the machine proxy's existing JSON `502`/`504` error envelope, including `error`, `machineId`, `statusCode`, and `detail`; a missing machine retains `404 {"error":"Machine not found"}`. These are federation failures, not file-view plain-text errors, and the preview adds no second transport error channel.

### 6.4 Origin rejection

A rejected protected request, including an upgrade, is HTTP `403` with the exact JSON body:

```json
{"error":"Cross-origin request rejected"}
```

The hook sets `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. Fastify may supply a correct fixed JSON length and normal HTTP transport headers. Do not add CORS allow headers, a redirect, a socket close frame, or an HTTP 101. No handler or upstream bridge runs. File-view plain-text error formatting does not apply to this app-wide JSON rejection.

## 7. Origin normalization, derivation, and rejection

### 7.1 Canonical origin syntax

`normalizeBrowserOrigin(value)` uses a trimmed inspection string and returns its serialized `URL.origin` or `undefined`:

1. Require an explicit `http://` or `https://` scheme, case-insensitively, followed by an authority and optionally one terminal `/`. No relative/protocol-relative value or wildcard is accepted.
2. Before URL normalization, reject whitespace/control characters inside the trimmed string, any backslash, `?`, `#`, `@`, `*`, or comma, and any path beyond the optional single terminal slash. This prevents URL normalization from hiding `/a/..`, empty `?`/`#` delimiters, empty credentials, wildcard authorities, origin lists, and backslash paths.
3. Parse with `new URL`; require protocol http/https, a nonempty hostname, empty username/password, and empty query/fragment. Require pathname `/`. Reject invalid authority/port syntax through URL parsing. IPv6 bracket authorities and normal IDN URL normalization are supported.
4. Return `url.origin`: lowercase URL-normalized host, canonical scheme, removal of default ports and terminal slash, preservation of nondefault ports. `HTTPS://PI.EXAMPLE:443/` becomes `https://pi.example`.

`null`, `*`, origin lists separated by commas/spaces, `https://u:p@host`, `https://host/a`, `https://host/a/..`, `https://host?`, `https://host#`, and non-http schemes are invalid. The optional root slash is an accepted spelling of no path, not permission for arbitrary paths.

### 7.2 Request origin derivation

`requestOriginFrom(request)` follows these steps:

1. Read `request.headers.host`. Require one nonempty string authority; reject arrays, embedded comma/whitespace/path/query/fragment/credentials/backslash, and multiple raw Host fields. Use neither `X-Forwarded-Host` nor the remote machine registry.
2. If `X-Forwarded-Proto` is present, take its first header value and the first comma-separated token, trim, and lowercase it. Only `http`/`https` is valid. A present but empty/invalid first token makes the derived origin `undefined`; do not fall back to a later token or socket. The first token is used even when Fastify's `trustProxy` is false, as required by the approved deployment contract.
3. Otherwise use `https` only when the actual request socket's `encrypted` property is `true`; use `http` for the other socket protocol. Do not infer TLS from a port or `Origin` itself.
4. Normalize `${scheme}://${host}` through `normalizeBrowserOrigin`. Return `undefined` if anything is invalid.

A forwarded scheme participates in full-origin matching only. It never admits a foreign host or port. There is no broad `trustProxy` configuration change.

### 7.3 Predicate

`isAllowedBrowserOrigin` is pure:

1. If `origin === undefined`, return true.
2. Normalize the supplied origin; failure, including the string `null`, returns false regardless of the allowlist.
3. Normalize `requestOrigin` when present. Return true if it equals the normalized origin.
4. Otherwise return true if **any valid normalized** `allowedOrigins` item equals it; invalid entries never act as patterns or grants.
5. Return false.

A missing/invalid derived request origin cannot grant same-origin access, but an explicit valid allowlist entry still can. Matching is exact scheme/host/effective port after URL normalization; there are no host suffixes, localhost exceptions, substring matches, wildcards, or `allowedHosts` fallback.

### 7.4 Fastify hook and startup activation

`registerBrowserOriginGuard` clones and normalizes the supplied array (default `[]`) at registration. An invalid injected startup item throws `Error("Invalid allowedOrigins startup snapshot")`; it never causes an allow-all fallback. The closure must not retain a mutable caller-owned array.

Install a root `onRequest` hook that applies when either:

- `request.method.toUpperCase()` is exactly `POST`, `PUT`, `PATCH`, or `DELETE`; or
- a case-insensitive comma-separated `Upgrade` header token is `websocket`, independent of method.

For protected requests, absent `Origin` proceeds. A single present string is passed to the predicate. Multiple raw `Origin` fields, string arrays, empty present values, or comma-joined lists are present-invalid and rejected; never turn them into `undefined`. The hook sends and returns the section 6.4 reply on denial, before body parsing and any route handler. Safe non-upgrade GET/HEAD and ordinary OPTIONS are unaffected, even if Origin is foreign or malformed. Existing CORS behavior is unchanged.

In `buildApp`, immediately after the injected/default config service is available and before application routes register, read `(await configService.read()).effectiveConfig.allowedOrigins ?? []` once and register the hook. A read/validation failure stops construction. Subsequent file access may read config dynamically, but the guard does not. No new config owner or polling loop is introduced.

In sessiond, `config` already comes from `effectivePiWebUiConfig({ env: daemonEnvironment })` at startup. Pass its allowlist to `createSessionDaemonApp`, which installs the same hook before runtime route registration. A TCP listener's unprefixed routes are protected as well as a Unix-socket daemon. Gateway-to-daemon clients normally send no Origin and continue to work.

The installed WebSocket plugin routes upgrade requests through ordinary Fastify hooks and calls `handleUpgrade` only in the eventual handler. The acceptance boundary is therefore an HTTP 403 handshake, with zero route/bridge/service calls. Do not guard only a post-upgrade callback.

## 8. Configuration persistence and round-trip

### 8.1 Schema and validation

Global file example:

```json
{
  "allowedOrigins": ["https://pi.example", "https://pi.example:8443"]
}
```

The field is optional. When present it must be an array of strings; each entry must satisfy section 7.1. `null`, booleans, numbers, objects, scalar strings, and any invalid array item reject the entire field. Do not discard an invalid item or continue startup with an empty list.

`parseAllowedOriginsConfig(value, source)` normalizes valid entries and deduplicates by serialized origin while preserving first occurrence order. It returns a fresh array, including for `[]`. Its exact validation error is:

```text
PI WEBUI config allowedOrigins must be an array of absolute http/https origins without credentials, paths, queries, or fragments: <source>
```

Use the actual global filename as `<source>` for file parsing, `request` for gateway request parsing, and the provided response-parser source for remote config response parsing. The existing selected-machine wrapper changes the initial `PI WEBUI config ` prefix to `PI WEBUI selected-machine config ` for bad selected-machine requests. Browser response parsing catches validation failure and throws exactly `Invalid PI WEBUI allowedOrigins field`.

Project-local `.pi-webui/config.json` does not gain this key. The existing project parser ignores unrecognized top-level keys; an accidental project-local `allowedOrigins` has no effect and must not enter an effective origin allowlist. Documentation says it is unsupported there. There is no environment override; an environment variable with the apparent name `PI_WEBUI_ALLOWED_ORIGINS` is ignored.

### 8.2 Persist, expose, preserve, clear

1. Parse and normalize on file load, service-save validation, HTTP request parsing, server remote-response parsing, and browser response parsing. Use the pure shared normalizer consistently, with boundary-specific error messages.
2. Add `allowedOrigins` to the known keys deleted from the existing raw object before merging a complete normalized file save, and to the serialized known-key record when defined. This prevents stale raw values surviving explicit replacement while preserving unrelated unknown keys through the existing mechanism. Do not build a new persistence route or bypass the existing mutation coordinator.
3. Omitted file key and `[]` both mean no extra trust at runtime. A file with `[]` loads/serializes as an explicit empty array. Do not synthesize an empty key into a previously absent raw config just for display.
4. `GET /api/config` exposes the key, when present, in **both** `config` and `effectiveConfig`; existing speech redaction still applies. A successful global `PUT /api/config` returns the same projection.
5. `GET /api/machines/local/config` and its successful PUT response expose it in both fields through `pickSelectedMachineConfig`. Add it to `SELECTED_MACHINE_CONFIG_KEYS`, so a selected-machine PUT may set or clear it. Its omission in the patch preserves the stored value, as for other selected-machine keys. Remote config reads/writes use this same projection and server parser, not a new wire API.
6. For the **new key only**, omission in a global PUT also preserves the current value inside the existing coordinated `service.update` callback. Do not change other keys' replacement semantics. Explicit `allowedOrigins: []` clears the trust; `null` is invalid. This makes omission by an older client safe while retaining explicit clearing. Use own-field/undefined distinctions from the parsed request, not truthiness of an array.
7. Add the property to `parsePiWebUiConfigResponseValues` and the browser's `parsePiWebUiConfigValues`. Extend private server `parseConfigRequest` to `(value: unknown, agentPathHost: AgentPathHost = "current", allowedOriginsSource = "request"): PiWebUiConfig`; pass that source to `parseAllowedOriginsConfig`. `parsePiWebUiConfigResponseValues` calls it with its own `source` as the third argument. This keeps normal requests at `request` and remote response failures at the response's source. A malformed remote/browser response fails parsing, rather than silently dropping security state.
8. Add an optional-array copy to `preservedGatewayConfigRemainder` so `gatewayServerConfigFromDraft` round-trips a configured or explicitly empty list while changing host/port/allowedHosts. Other builders that already spread base config retain it naturally. The General Settings machine-access patch must not invent/clear it. No editable UI list or new draft field is added.
9. `envOverrides` remains unchanged: there is no `allowedOrigins` flag. Both config projections report desired config, including a just-saved new list, without claiming it is already active in either process.

### 8.3 Activation and proxy guidance

The gateway and session daemon each copy their allowlist once on construction. Mutating the original array, saving new config, changing a fake config provider's value, or changing `process.env` cannot alter a running guard. New compositions read the new value.

Applying a changed `allowedOrigins` therefore requires restarting **both web/API and session daemon on the machine whose requests are being checked**. Existing UI/API autoreload cannot load the daemon hook or its startup snapshot. The delivery handoff must state that `pi-webui-sessiond.service` needs a manual restart. This specification authorizes no automatic service restart.

A reverse proxy preserving Host and supplying the correct first `X-Forwarded-Proto` token needs no extra origin. A proxy rewriting Host needs the public full origin, including a nondefault port, on that target machine. `allowedHosts` remains solely Vite development host admission and grants no browser-origin trust.

Default machine clients forward no browser Origin. If the operator configures an `Origin` header on a machine record, preserve it for HTTP and sockets: an origin equal to the remote effective request origin works with `[]`; a different valid origin must be listed in that **remote** machine's `allowedOrigins`. A malformed or `null` configured origin is always denied, even if someone attempts to put it in an allowlist.

Safe cross-origin GET/HEAD responses have no newly granted CORS read access. A preview may navigate elsewhere, but foreign unsafe actions and socket upgrades are rejected. DNS rebinding can still make an attacker's Host and Origin agree; the feature does not claim protection against it.

## 9. User-facing error taxonomy

| Layer | User-visible result | Recovery/behavior |
| --- | --- | --- |
| Incomplete client workspace context | Original link/image attribute; no warning/toast | No guessing or gateway-local fallback. |
| Recognition non-match | Original attribute and current navigation semantics | Includes external/app links. |
| Resolver exception | Exact original for that element; siblings still processed | No preview URL remains from an earlier resolver. |
| Required/invalid query | Exact 400 plain-text page from section 6.3 | Correct the link. |
| Unauthorized file or failed open protection | Exact 403 plain-text external-path guidance | Grant only an appropriate root on the owning machine. |
| Missing target/context | Exact 404 plain-text page | Regenerate the file or correct workspace context. |
| Too large | Exact 413 plain-text limit page | Reduce the file below the fixed cap. |
| Unsupported/nonregular | Exact 415 plain-text page | Open it using an appropriate local tool. |
| Unexpected local pre-stream failure | Generic 500 plain-text page; detailed server log | No stack or secret configuration in the response. |
| Stream truncated, read failed, or client left | Incomplete/aborted transfer; no second page or clean EOF | A new click reopens/rechecks the file. |
| Remote offline/timeout | Existing gateway 502/504 JSON | Existing machine transport behavior. |
| Cross-origin browser action/upgrade | Exact 403 JSON rejection | Configure a legitimate public origin if the proxy rewrites authority; restart both owners. |
| Invalid origin config | Exact validation error at load/save/parse boundary | Repair the entire field; no silent weakening. |

There is no new in-app preview modal, download action, error notification, or retry controller.

## 10. Required test specification

Each subsection owns **one** named case list for its file. Named table-driven cases expand deterministically as described; an expansion is a separate reported test case. Fixtures use explicit independent expected values. A test fails for a broken mechanism only if its unmodified baseline passes. Do not count import errors, missing tooling, unrelated existing failures, or a timeout caused by an unbounded test harness as regression kills.

Prefer the smallest boundary and existing typed fakes. Use real DOM/custom-element rendering for UI property/content contracts; do not extract arbitrary `TemplateResult.values`. File-race tests use explicit injected phase barriers rather than scheduling sleeps. Socket tests observe real HTTP handshake responses using `ws`'s `unexpected-response` event and clean up accepted sockets, or the existing injection helper only when it exposes the same status and no-upgrade proof. Tests assert a positive allowed control as well as denial.

### 10.1 `src/shared/fileViewTypes.test.ts` (new)

- `classifies <extension> as <kind>` — one case for every extension in section 3.1, with an independently written table. Removing any mapping fails its case.
- `classifies uppercase final extensions on POSIX and Windows paths` — mixed separators and `.HTML`/`.PDF`/`.PNG`/`.TSX`; fail if case/separator handling is removed.
- `rejects unknown, extensionless, dotfile-only, trailing-dot and directory paths` — `a.exe`, `Makefile`, `.html`, `a.`, `folder.html/`, `folder.svg\\`; exact undefined results.
- `uses only the final leaf and does not parse URL suffixes` — `dir.html/a.txt` is text, `a.html.exe` undefined, `a.html?x=1` undefined.
- `has a MIME type for every shared image extension` — invoke the real existing `imageMimeTypeForPath` for each shared image entry and assert exact MIME. Do not require equality with its SVG-inclusive set.
- `exports the exact 64 MB preview cap and label` — independently expect `67_108_864` and `64 MB`.

### 10.2 `src/shared/browserOrigins.test.ts` (new)

- `normalizes <origin spelling>` — table includes HTTPS uppercase host/default port/root slash, HTTP default port, nondefault port, bracket IPv6, and an IDN. Compare independent serialized strings.
- `rejects <invalid origin syntax>` — one case each for null string, empty, wildcard, relative, protocol-relative, non-http, user/password, empty-user `@`, path, normalized-away `/a/..`, repeated slash, query including empty `?`, fragment including empty `#`, backslash, embedded whitespace/control, comma list, and invalid port. Removing pre-normalization rejection must fail the normalized-away-path/delimiter cases.

### 10.3 `src/client/src/transcriptFileLinks.test.ts` (new)

Use jsdom with the real URL helper, Vite base `./`, and a document base URI consistent with each application-base fixture. Use cwd `/ramdisk`, ids `project /?`, `workspace ?/`, machine `remote /?`, and browser application base fixtures `/` and `/tools/pi/`. Assert the returned absolute URL by pathname/search/hash; include at least one independently literal full URL so the helper itself is not the expected-value oracle.

The resolver fixture table below is normative. `decline` means return `undefined` and leave the written attribute unchanged; otherwise the middle cell is the exact `path` query value after URLSearchParams decoding. The default context is cwd `/ramdisk`, app base `/`; rows naming another cwd/base override only those fields. The hash column is the exact client fragment appended to the generated URL.

| Raw target / context override | Expected path or result | Hash |
| --- | --- | --- |
| `/ramdisk/pelican-bicycle.html` | `pelican-bicycle.html` | empty |
| `/ramdisk/output.unknown` | `output.unknown` | empty |
| `/ramdisk` | `.` | empty |
| `/ramdisk2/a.html` | `/ramdisk2/a.html` | empty |
| `/outside/a.png` | `/outside/a.png` | empty |
| `/outside/README` | decline | — |
| `a.html` | `a.html` | empty |
| `././reports/a.pdf` | `reports/a.pdf` | empty |
| `../a.html` | `../a.html` | empty |
| `README` or `a.exe` | decline | — |
| `file:///ramdisk/a.html` | `a.html` | empty |
| `file://localhost/ramdisk/a.html#part` | `a.html` | `#part` |
| `FILE:///ramdisk/a.pdf?download=1#page=3` | `a.pdf` | `#page=3` |
| `file://otherhost/ramdisk/a.html` | decline | — |
| `file:relative.html` or `file:/ramdisk/a.html` | decline | — |
| `caf%C3%A9%20plot.html` | `café plot.html` | empty |
| `a%3F%23.html?discard=yes#part` | `a?#.html` | `#part` |
| `a+b.html` | `a+b.html` | empty |
| `a%ZZ.html` | `a%ZZ.html` | empty |
| `a%FF.html` | `a%FF.html` | empty |
| `a%2520.html` | `a%20.html` | empty |
| `a.pdf?download=1#page=3` | `a.pdf` | `#page=3` |
| `a.html#part?still-fragment` | `a.html` | `#part?still-fragment` |
| `https://outside.example/a.html`, `http://outside.example/a.html`, `mailto:user@example.test` | decline | — |
| `#part`, `?view=a.html`, `//cdn.example/a.svg` | decline | — |
| `api/a.html`, `./pi-webui-plugins/a.svg`, `/assets/a.png` | decline | — |
| `%61pi/a.html` | decline | — |
| `apian/a.html` | `apian/a.html` | empty |
| `/tools/pi/report.html`, base `/tools/pi/` | decline | — |
| `/tools/piano/report.html`, base `/tools/pi/` | `/tools/piano/report.html` | empty |
| `/ramdisk/a.html`, base `/tools/pi/` | `a.html` | empty |
| `/a.html`, cwd `/` | `a.html` | empty |
| `C:\Work\Repo\a.HTML`, cwd `c:/work/repo/` | `a.HTML` | empty |
| `file:///C:/Work/Repo/a.html`, cwd `c:/work/repo` | `a.html` | empty |
| `C:/Work/Repo2/a.html`, cwd `C:/Work/Repo` | `C:/Work/Repo2/a.html` | empty |
| `C:/a.html`, cwd `C:/` | `a.html` | empty |
| UNC spelling `\\server\share\a.pdf` | decline | — |

Required named cases:

- `resolves <candidate>` — named rows: root cwd child HTML, cwd child unknown extension, cwd exact root (`path=.`), relative HTML, `./`-relative PDF, root external PNG preserved absolute, empty-authority file URL, localhost file URL, uppercase file scheme, encoded Unicode/space filename, encoded literal `?`/`#`, literal plus, malformed percent fallback, invalid UTF-8 fallback, once-only `%2520` decode, dropped query, PDF page fragment, and query plus fragment. Assert exact request path and retained hash for each.
- `does not strip a near cwd prefix` — `/ramdisk2/a.html` remains absolute; deleting the separator check fails.
- `recognizes Windows paths before schemes and compares drive paths case-insensitively` — cwd `C:\\Work\\Repo\\`, targets both slash forms and mixed case, plus `file:///C:/Work/Repo/a.html`; exact relative remainder. POSIX case-difference remains unmatched cwd and absolute.
- `preserves filesystem roots during cwd comparison` — `/` and `C:/` child and exact matches; no duplicate/lost separator.
- `declines <non-file target>` — empty, whitespace-only, anchor, query-only, HTTP, HTTPS, mailto, javascript, protocol-relative, unsupported relative extension, extensionless relative, remote file authority, file credentials/port, `file:relative`, `file:/single`, and UNC form.
- `excludes <application namespace form>` — Cartesian table of `api`, `pi-webui-plugins`, `assets` with relative, `./`, root-absolute, and percent-encoded spelling; each includes a previewable extension. Assert undefined. Near-prefix `apian/a.html` is a positive control.
- `excludes a nested effective base without excluding its near-prefix or root deployment` — `/tools/pi/a.html` undefined under nested base; `/tools/piano/a.html` accepted; `/ramdisk/a.html` accepted under `/`; skip the base exclusion and the first assertion fails.
- `retains traversal for the server authorization boundary` — `../a.html` uses exact `path=../a.html`, never a browser URL traversal.
- `returns context for the matching workspace rather than the selected-looking first workspace` — workspace list contains another workspace first and the cwd match second; expect second ids.
- `normalizes context comparisons only for slash and Windows case rules` — matching trailing separators, drive case, and POSIX nonmatching case.
- `disables context and direct resolution for incomplete ownership` — no cwd, no match, empty project/workspace/machine, and invalid base; exact undefined.

### 10.4 `src/client/src/formatting/markdown.test.ts` (extend)

Use `toSafeMarkdownHtml`, parse its result into a template, and assert `getAttribute` on actual anchors/images. Do not test a separately exported sanitizer.

- `preserves <safe candidate> on <attribute>` — link/image rows for relative path, `./`, `../`, root path, query-only, protocol-relative, Windows slash form, Windows backslash form using valid Markdown escaping, local `file://`, localhost `file://`, and nested relative name with a later colon. Exact written attributes survive; reverting `isSafeUrl` fails the new relative/file cases.
- `removes <unsafe scheme> from <attribute>` — link/image rows for javascript, data, vbscript, and unknown scheme, including uppercase and tab/newline-obfuscated active schemes. Assert attribute absence, not merely text absence.
- `retains external anchor target and rel behavior` — exact HTTP/HTTPS/mailto/# attributes plus `_blank` and `noreferrer noopener`.
- `caches only the written file targets` — repeated Markdown render contains original href/src and no `/file/view`, before and after DOM enhancement in component tests.

### 10.5 `src/client/src/api/urls.test.ts` (extend)

Run the new DOM-dependent block with a jsdom environment; use document base URI and Vite env stubs restored after each test.

- `builds an encoded browser-ready file view URL on the current origin` — machine `remote /?`, project `project /?`, workspace `workspace ?/`, path `dir/a ?#%+.html`; independently expect `%20`/`%2F` in segments and URLSearchParams encoding in the query. Assert no remote configured origin and no fragment.
- `defaults file view URLs to the local machine` — omitted options produces `/api/machines/local/...` on the current app origin.
- `resolves file view URLs exactly once beneath the effective nested base` — Vite `./` with document base `https://gateway.example/tools/pi/`; for the first case's ids/path the independently expected complete string is `https://gateway.example/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html`. It must not use origin-root `/api/` or duplicate `/tools/pi/`.

### 10.6 `src/server/workspaces/fileViewService.test.ts` (new)

Create a real temporary workspace and a separate allowed root/outside root. Fixtures include HTML, HTM, SVG, PDF bytes, PNG bytes, UTF-8 text, unknown extension, directory, zero-byte HTML, and a sparse file of cap+1. Use real operations by default; injected operations delegate to real operations where feasible and expose explicit before/after barriers. Assert streamed bytes and eventual close, not only metadata.

- `opens <supported kind fixture> with exact metadata and bytes` — HTML/HTM/SVG/PDF/PNG/text; checks display path, kind, media type, size, ISO modifiedAt, and full bytes.
- `rejects absent and empty paths before authorization` — 400/message and zero authorize/open calls.
- `rejects NUL paths before authorization` — 400/message, zero open.
- `denies traversal, unconfigured absolute paths and symlink escapes` — each 403/message, no successful stream. Test a real inside-to-outside symlink on supported hosts.
- `reads an absolute path only through a configured allowed root` — positive allowed-root file and negative near-prefix sibling; do not accidentally grant absolute workspace paths without allowlisting.
- `maps a missing target to 404 while retaining the request path` — exact body message for a relative target.
- `rejects oversized files after handle measurement and accepts the exact cap` — fstat cap+1 fails 413/close; a bounded fake handle with exact cap is admitted without allocating 64 MB in the test.
- `rejects directories and unknown extensions with 415` — directories with a supported-looking name and ordinary unknown files; handles closed after open.
- `uses no-follow and nonblocking flags on <POSIX platform>` — Linux and darwin seam rows assert each flag is present and O_RDONLY semantics. Replacing flags with `r`/O_RDONLY alone fails.
- `rejects a FIFO without a writer within the parent-owned deadline` — real FIFO child probe, 415/message and normal cleanup. Use ready/go IPC after imports and authorization: the child announces immediately before the open under test, the parent starts the 1-second monotonic deadline and releases it, and the parent terminates/reaps it on expiry. Thus loader/startup time is outside the open deadline. Removing O_NONBLOCK fails this bounded case.
- `rejects a final-component symlink swapped after authorization` — authorize barrier replaces the canonical final entry by an in-root symlink, then the real POSIX open gets ELOOP/403. Its destination is **inside** the root so only no-follow, not outside containment, kills the mutation.
- `rejects an opened Linux handle outside its granting root` — injected open returns a real handle in the separate outside directory while authorize returns an inside target; `/proc` resolves outside, 403/close. Removing the fd containment check fails.
- `rejects a Linux opened-handle near-prefix sibling` — root `/.../root`, handle under `/.../root2`, 403; a naive startsWith check fails.
- `fails closed when Linux fd containment lookup fails` — injected `/proc` lookup rejects, 403/close; accepting lookup failures fails.
- `does not perform Linux fd lookup on another POSIX host` — darwin seam with a lookup that would throw if called, regular file succeeds.
- `streams the pinned handle when the pathname is replaced after open` — first let the opener finish fstat/containment and return its paused stream, then replace the pathname before stream consumption; returned bytes are original inode bytes. A pathname createReadStream mutation fails. Do not unlink the inode before Linux's containment lookup and then expect that fail-closed lookup to succeed.
- `bounds a file grown after fstat at its measured size` — append before consumption, assert exactly old bytes and exact stream end bound. Removing the end bound fails.
- `returns a zero-byte stream without reading a file that grows after fstat` — measured zero then append before consumption; exact empty stream and close. The zero-size special case is load-bearing.
- `uses conclusive Windows identity and fstat size` — win32 seam, matching positive inode/dev, different pre-open size, accepted fstat size; open uses O_RDONLY and no `/proc`.
- `denies <Windows identity failure>` — rows: lstat symlink, dev mismatch, ino mismatch, zero inode, missing/NaN metadata, unsafe integer identity. Assert 403 and whether open must remain uncalled (symlink) or handle closes (post-open failures).
- `closes every handle on <post-open failure>` — fstat rejection, nonregular metadata, invalid size, oversized, Windows mismatch, Linux lookup failure, unknown kind, and createReadStream throw; primary status/error preserved and close observed once before ownership transfer.
- `maps permission errors to 403 and unexpected filesystem errors to rejection` — EACCES/EPERM/ELOOP versus EIO; EIO is not misreported as a supported file.

Short-stream HTTP assertions belong to the reply test, not a claim that a raw ReadStream EOF knows its previously measured length.

### 10.7 `src/server/http/fileViewReply.test.ts` (new)

Use a small real Fastify server and real ReadStreams over temporary fixtures; inject phase barriers before the helper starts the source. Observe Node HTTP `end`, `aborted`/error, byte count, source `close`, and final response headers. Every terminal event is recorded before releasing the relevant barrier. Use explicit deadlines only as test-harness failure bounds.

- `streams an exact body without fixed Content-Length and closes the handle` — positive regular-file control, complete end, correct bytes, source close.
- `sets the independently specified full document policy for HTML and SVG` — literal full CSP written in the test, never imported as its expected value; assert all success headers. Removing sandbox/connect/form/frame/base/worker/object directives fails exact equality.
- `does not set document CSP on PDF image or text responses` — kind rows with exact type/no-store/nosniff/referrer and no disposition/range/cache validators.
- `aborts a file truncated to <remaining bytes> after fstat` — rows partial and zero. Assert aborted/error and **no clean response end**, and source close. Removing final byte-count verification fails.
- `aborts a source read error without appending an error page` — fail after headers and partial bytes; socket incomplete, no JSON/plain-text replacement body, handle close.
- `rejects a counter overflow instead of completing a long body` — construct inconsistent declared size against a real longer ReadStream through the adapter boundary; this specifically pins the counter independently of the service's end bound.
- `closes source and counter when the client disconnects` — client leaves after first chunk; close observed and no continued source reads.
- `cleans up an already disconnected reply and a send-setup failure` — no stream is left open and owned listeners/scope disposed.
- `flushes final compression-negotiated headers before releasing the source` — register the existing compression plugin, use a body above threshold and gzip Accept-Encoding; assert observed headers before source release, decoded bytes exact, no Content-Length. A pre-Fastify flush mutation fails.
- `finishes a genuinely empty file cleanly with no fixed length` — complete empty control distinguishes legitimate empty from truncation.

### 10.8 `src/server/workspaceExplorerRoutes.test.ts` (new)

Register the real route module twice on a small Fastify app with real ProjectService/ProjectStore/WorkspaceService fixtures, and an injected config `read` provider. Use real file service except a narrow opener spy for route-argument/abort cases.

- `serves <kind> through <local alias>` — HTML, SVG, PDF, PNG, text × `/api` and `/api/machines/local`; assert status, bytes, exact content type and all common headers. Document cases compare a literal full CSP independent of the production constant.
- `returns <file failure> as an exact plain-text page through <local alias>` — missing/empty path, repeated path, NUL, forbidden root/traversal, missing target, too large, directory, unsupported extension × aliases; exact status/body and all error headers from section 6.3.
- `distinguishes unknown project workspace and infrastructure failures` — separate fixtures for ProjectNotFoundError, context's Workspace not found, and config read rejection; exact 404/404/500 plain-text results.
- `passes hosting-machine effective global and project roots to the opener` — project config contributes one allowed path, global provider contributes another; outside denied and allowed path succeeds. Removing effective-path resolution fails.
- `does not decode the path a second time` — literal filename containing `%20`, query produced from that string; opener sees `%20`, not a space.
- `returns a whole 200 body for a Range request` — no Content-Range/Accept-Ranges, full bytes.
- `keeps default HEAD handling bodyless and closes the created stream` — no new negotiation; a normal same-file GET remains the positive byte control.
- `releases a stream returned after the reply disconnects during open` — deferred opener, close reply, resolve real view; source closes, no attempted successful send.

### 10.9 `src/shared/federatedRoutes.test.ts` (new)

- `federates exactly one GET workspace file view route` — expect the literal spec once in FEDERATED_HTTP_ROUTES, with no timeout override.
- `adds no mutation or socket counterpart for file view` — no POST/PUT/PATCH/DELETE view spec and no new view socket entry. Do not snapshot unrelated route inventories.

### 10.10 `src/server/app.remoteProxy.test.ts` (extend)

Reuse `appTestContext`, `fakeRemoteClient`, real nonlocal machine registration, and the existing body/stream harness.

- `forwards file view bytes and every required document header from a nonlocal machine` — fake upstream HTML with independently literal CSP, no-store, nosniff, referrer-policy, and a forbidden set-cookie; assert exact bytes, all required headers, no cookie, no fixed length, and encoded path/query forwarded to `/api/projects/.../file/view`. Deleting federated registration or `referrer-policy` allowlisting fails.
- `forwards exact plain-text file view failure status body and headers` — upstream 400/403/404/413/415/500 rows; no conversion to JSON.
- `preserves an interrupted upstream file view as an interrupted downstream transfer` — use real-listener delayed/error stream pattern; must not end cleanly or append gateway JSON after flushed headers.
- `preserves allowedOrigins through remote selected-machine config reads and writes` — remote response parser plus projection retain normalized populated and empty arrays in config/effectiveConfig; configured key survives PUT validation and its exact forwarded patch.

### 10.11 `src/client/src/components/FormattedText.test.ts` (extend)

Use jsdom, real `FormattedText`, real Markdown rendering/cache, and per-test DOM cleanup. Resolve only `[local](a.html)` / `![local](plot.svg)`; provide an external control.

- `rewrites file anchor and image attributes and marks only matches` — assert DOM href/src via getAttribute, marker, existing anchor target/rel, and untouched external attributes.
- `keeps the same elements while resolving A then B from the original targets` — same Markdown text and exact node identity; resolver spies both receive original targets, B URL replaces A.
- `restores original attributes when a replacement resolver declines` — transition A → B → resolver returning undefined on the **same nodes**; exact originals and absent marker. Removing only the non-match restoration branch fails.
- `restores original attributes when the resolver disappears` — independently transition a rewritten B node directly to no resolver, then re-enable A. This test must not start only from an already-restored node.
- `restores a throwing element and continues enhancing its siblings` — first resolver throws for anchor, matches image; original anchor restored and image enhanced.
- `isolates two workspace resolvers sharing cached Markdown` — two components, same cached text, different resolved destinations; cache read afterward still has original targets and no preview URL.
- `records new originals after Markdown replaces nodes` — change text to a different file target, assert replacement node and new original used/restored.
- `enhances links when a live plain-text tail settles without changing plain-text rendering` — no links during plain phase, correct rewrite after `live=false`.

### 10.12 `src/client/src/components/ChatView.fileLinks.test.ts` (new)

Use jsdom and the existing real-DOM mounting/disclosure pattern from `ChatView.latex.test.ts`. Open the actual event-group details and await child `updateComplete`. A resolver spy is assigned to the parent, and child properties plus actual rewritten links are asserted.

- `forwards the resolver at <render site>` — one case each for queued text, message text (cover both user/assistant fixtures), thinking, skill invocation, and tool result. Each fixture has a distinct local target and proves the expected child exists, its `resolveFileLink` is exactly the parent function, and its DOM URL is rewritten. Removing any single binding fails its named case.
- `updates existing formatted children when the resolver is replaced or removed` — same messages, B then undefined, await children and assert B/original respectively.
- `keeps bash output on its existing plain-text surface` — no formatted child introduced for bash output.

### 10.13 `src/client/src/components/PiWebUiApp.fileLinks.test.ts` (new)

Use jsdom. Construct a detached real app and set its state with a typed/reflection helper consistent with the repository. To avoid starting unrelated controllers/network polling, call its existing `renderChatView` boundary and use Lit `render(template, container)` to mount the **real template and real chat-view**, then read the component property. This is DOM property testing, not TemplateResult handler extraction; do not mount a fabricated chat-view using a separately computed resolver.

- `binds selected remote session workspace and machine ownership to the rendered chat view` — remote machine whose configured baseUrl differs from browser origin, project with two workspaces, session in second workspace; invoke actual child resolver and assert gateway origin plus encoded remote/project/second-workspace/path.
- `derives nested application exclusion from the effective AppUrlContext` — Vite `./`, document base `https://gateway.example/tools/pi/`; resolver declines `/tools/pi/report.html`, accepts cwd HTML, and generated URL is under `/tools/pi/api/`. A literal-BASE_URL or root-base mutation fails.
- `binds undefined when session cwd or selected-project ownership has no match` — nonmatching cwd, absent selected project, workspace with another project id, or incomplete ids; child property is undefined.
- `reuses resolver identity only while its complete ownership tuple is equal` — unrelated state republish/new equal workspace objects reuse function; session/cwd/project/workspace/machine changes replace it and produce new URLs. Machine forced to local must fail the first/changed-machine case.

### 10.14 `src/server/http/browserOriginGuard.test.ts` (new)

- `allows an absent browser Origin without an inferred request origin` — predicate true for absent origin and malformed/missing request origin.
- `matches exact normalized origins and explicit allowedOrigins` — same full origin, default-port equivalence, forwarded HTTPS derivation, and explicit different valid origin; exact positive controls.
- `rejects <origin mismatch or malformed value>` — different scheme/same host, different host, different port, null string, empty, malformed, credentials, path/query/hash, non-http, comma list. Invalid incoming origin remains false even if the raw invalid string is in allowedOrigins.
- `does not derive trust from allowedHosts-shaped patterns` — wildcard/suffix strings in allowedOrigins never grant access.
- `derives the request origin from socket protocol and Host` — HTTP socket, encrypted socket, host nondefault port, IPv6; independent expected origins.
- `uses only the first forwarded-proto token and ignores forwarded host` — `https, http` accepted as HTTPS; `bad, https` and empty first token undefined; foreign X-Forwarded-Host changes nothing.
- `fails closed on malformed or duplicate Host and present-invalid forwarded proto` — direct small typed Fastify boundary fixture; no invented origin.
- `treats duplicate or present-invalid Origin as rejection rather than absence` — hook boundary with raw duplicate fields/array where supported, empty header, and comma list; 403/zero handler calls.
- `guards case-insensitive websocket upgrade tokens before handling` — GET with mixed-case `WebSocket`, and a token list; foreign rejected. A non-websocket ordinary GET is unaffected.
- `pins a copied startup allowlist and rejects invalid injected snapshots` — mutate input array after registration; no trust change; invalid snapshot throws the exact startup error.

### 10.15 `src/server/app.originGuard.test.ts` (new)

Construct real `buildApp` with typed injected services, an initial config response, a counting daemon/remote client, and a real temporary workspace. Existing test-support helpers may supply fake dependencies, but do not install the guard in test code or mock `isAllowedBrowserOrigin`.

Define these named parameterized matrices. Their exact dimensions are contractual. For injected HTTP fixtures set `Host: pi.test:8808`: `matching` is `http://pi.test:8808`, `foreign` is `https://foreign.example`, `null` is the literal string `null`, `malformed` is `%%%`, and `absent` means omit the header entirely. For real socket fixtures, matching is the HTTP origin of the server's actual ephemeral listener; retain the same foreign/null/malformed spellings. Record the listener-derived expected origin explicitly in the fixture so host/port equality is controlled.

| Matrix | Dimensions | Required result |
| --- | --- | --- |
| `gateway <prefix> <method> <origin case>` | Prefix `/api`, `/api/machines/local`, `/api/machines/remote-a`; method POST/PUT/PATCH/DELETE; origin case matching, foreign, null, malformed, absent. | Matching/absent call the counting boundary once; foreign/null/malformed return exact 403 JSON, zero daemon/remote calls. |
| `gateway safe <prefix> <method> ignores foreign Origin` | Same three prefixes; GET and HEAD. | Existing safe counting route/proxy still runs; no guard rejection. |
| `gateway socket <prefix> <family> <origin case>` | Same prefixes; three session families plus workspace terminal socket; matching/foreign/null/malformed/absent. | Matching/absent actually reach a functioning fake upstream; other cases observe HTTP 403, zero 101, zero handler/service/bridge/remote-client calls. |

For unsafe HTTP, use existing concrete routes to prove coverage: POST `.../sessions`, PUT `.../sessions/s1/model-policy`, PATCH `.../skills`, DELETE `.../sessions/s1`, with valid request bodies where a local handler validates them. Supply typed fake daemon/remote responses appropriate for each. A counting test route may additionally isolate hook behavior, but is not a substitute for these registered paths.

For sockets, the exact gateway suffix families are `/events`, `/sessions/events`, `/sessions/s1/events`, and `/projects/<project>/workspaces/<workspace>/terminals/t1/socket`. The terminal suffix crosses `registerTerminalProxyRoutes` locally and `registerMachineProxyRoutes` remotely: both implementations must be exercised. There is no gateway `/api/terminals/t1/socket` route to invent. For rejection, compare counters before/after handshake including remote lookup/factory counters, not only the final client error.

Additional named cases in this same file:

- `gateway accepts the public HTTPS origin described by forwarded proto` — Host matches public authority, XFP HTTPS, exact HTTPS origin accepted, HTTP spelling denied.
- `gateway permits only an exact configured public origin after Host rewriting` — foreign origin denied with empty list, admitted by valid startup list, wrong port still denied; `allowedHosts: true` does not change denial.
- `gateway protects every unsafe method without awaiting body parsing` — malformed JSON plus foreign origin gets 403 and no parse/handler work, not a parser 400.
- `gateway retains its startup snapshot until rebuilt` — save a new list through config service under a permitted call, desired response changes, old app still denies it, new app with same provider accepts. Clearing is likewise inactive until rebuilt.

### 10.16 `src/server/sessiond/sessionDaemonApp.originGuard.test.ts` (new)

Use the production `createSessionDaemonApp` factory, real route registration functions, real `SessionEventHub`, and typed fake session/terminal services. Reuse section 10.15's exact origin-case spellings and listener-derived matching origin. The skills route currently takes the concrete `SkillsConfigService` class with private state: construct a real instance with a temporary agent dir and injected load/network/process dependencies, then spy/stub its public `toggle` to return `{ success: true }` and count calls. Do not cast a partial object to that concrete class or change its production route interface for this test. Do not load live agent credentials or start Pi, ptys, migrations, or a production listener. Listen on an ephemeral loopback TCP port when testing handshakes; this is the daemon exposure the guard must cover.

- `daemon <method> <origin case> guards the actual runtime route` — POST `/sessions`, PUT `/sessions/s1/model-policy`, PATCH `/skills`, DELETE `/sessions/s1`; matching/absent admitted, foreign/null/malformed denied before the corresponding fake service. Valid payloads ensure a positive control reaches service logic.
- `daemon socket <family> <origin case> rejects before runtime attachment` — families `/events`, `/sessions/events`, `/sessions/s1/events`, `/terminals/t1/socket`; matching/absent reach event subscription or terminal attach, foreign/null/malformed yield HTTP 403/no 101/no subscription/attach/write/resize. In particular null on the terminal path must never reach resize-before-attach behavior.
- `daemon reads a copied startup snapshot and changes only after reconstruction` — old/new list providers and rebuilt factory, with an accepted same-origin control.
- `ordinary absent-Origin traffic works across the real gateway to daemon hop` — connect a real `SessionDaemonClient` to the ephemeral fake-runtime daemon, inject a gateway POST and establish a gateway socket with a matching browser Origin, prove daemon sees no Origin and service/subscription runs. Explicit malicious Origin sent directly to the same daemon is denied.

This file tests the daemon edge itself, not just the gateway predicate. Removing the factory's hook must fail all rejected daemon matrix cases while accepted controls still run.

### 10.17 `src/config.test.ts` (extend)

Use a temporary global config and normal atomic save/load APIs; set only a task-local env object.

- `round-trips normalized allowedOrigins and preserves unrelated keys` — uppercase/default port/root slash/duplicates normalize, persisted JSON and loaded values agree, unrelated supported and unknown raw keys remain.
- `keeps absent and explicit empty allowedOrigins distinct in stored config` — absent remains absent; explicit [] persists and means no extra origins.
- `rejects <invalid allowedOrigins config value> without weakening the field` — non-array/null/mixed type plus every invalid-origin category from section 7.1; load and save fail with exact filename-source error. No tolerant error field is used.
- `ignores an apparent allowedOrigins environment override` — apparent env string plus explicit file list/absent file list, no effect and no env flag.

### 10.18 `src/server/configRoutes.test.ts` (extend)

- `exposes normalized allowedOrigins in both config response projections` — GET/PUT × gateway/local alias, check both config/effectiveConfig and unchanged envOverrides schema.
- `accepts allowedOrigins in selected-machine patches and preserves it on unrelated patches` — atomic service update sees the key; unrelated access patch retains list.
- `preserves omitted allowedOrigins on a global update and clears only with an explicit empty list` — start populated, save unrelated gateway fields, verify persisted list, then [] round-trip; no truthiness fallback resurrects it.
- `rejects <invalid origin payload> on <config alias> before persistence` — both aliases with the exact boundary-specific error prefix/source, no coordinator mutation or saved config.
- `parses allowedOrigins in server-side remote responses using the response source` — full/selected normalized values retained in both fields; malformed response fails with `Remote machine config response` source, not `request`.
- `retains allowedOrigins through committed-snapshot projection and speech redaction` — avoid accidentally deleting it while sanitizing a response.

### 10.19 `src/client/src/api/parsers.test.ts` (extend)

- `accepts optional normalized allowedOrigins in both config and effectiveConfig` — absent, populated, [] rows; exact normalized arrays, existing envOverrides without the new flag still accepted.
- `rejects malformed browser allowedOrigins instead of dropping it` — invalid array shape/item/origin categories in each response field; exact `Invalid PI WEBUI allowedOrigins field`.

### 10.20 `src/client/src/components/settings/settingsConfigDraft.test.ts` (extend)

- `preserves populated allowedOrigins while saving unrelated gateway fields` — base response list, draft host/port/allowedHosts change, output retains copied array. Removing preservation fails independently of the server's omission safeguard.
- `preserves explicit empty allowedOrigins without synthesizing an absent field` — [] remains [], absent stays absent; no shared mutable array reference.
- `does not add origin changes to selected-machine file-access patches` — existing machine-access builder output contains only its intended keys; remote patch merge owns preservation.

### 10.21 `src/server/workspaces/projectPiWebUiConfig.test.ts` (extend)

- `does not apply a project-local allowedOrigins key` — accidental populated project key plus existing path-access/upload settings; parsed/effective project data gains no origin trust and file-access/upload behavior remains intact.

### 10.22 `src/server/machines/machineClient.test.ts` (extend)

Use the real RemoteMachineClient with an injected fetch boundary for HTTP and a local WebSocket counting server for sockets.

- `sends no Origin by default for machine HTTP and WebSocket traffic` — explicit absence, not undefined-vs-absent object assumptions.
- `preserves a configured machine Origin for HTTP and WebSocket traffic` — configured case-insensitive header reaches both boundaries unchanged; existing blocked sensitive headers remain blocked.
- `configured matching Origin works against an empty remote allowlist` — real guarded remote app whose request origin equals configured origin; HTTP action and socket accepted with counters.
- `configured foreign Origin requires the remote startup allowlist` — empty remote list yields exact HTTP/handshake 403 and no service/attach, listed remote list accepts, different port still rejects. Do not satisfy this case using only a guard predicate mock.

## 11. Browser audit evidence

This is an executable acceptance probe, not a Vitest string/header substitute. Add the repo-local script named in section 2.3 and archive its script version, stdout JSON, browser version, and any diagnostics with the implementation audit report. Do not modify production guards/CSP to expose a test bypass.

Invocation contract:

```text
node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium <executable> --output-dir <audit-directory>
```

Both arguments are required; missing browser/tooling is a failed/unavailable audit, never a pass. The script uses the installed `ws` dependency for raw CDP, an ephemeral isolated browser profile, temporary authorized fixture files, and loopback servers; it tears down child processes, sockets, profiles, and fixtures even on failure. It must not connect to production sessions or send model requests. Use the real `buildApp` composition with fake runtime services and real preview routes. Any probe-only counting routes/header weakening are installed only by the script on its private loopback app.

Required stages and independent observations:

1. Serve a self-contained HTML animation through the real workspace file view. Capture its CSP/headers. Observe two distinct DOM animation positions or a monotonically increasing animation frame counter through CDP, proving scripts/animation run.
2. The fixture attempts fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, form submit, iframe, Worker, object, and base-URL manipulation against explicit counting endpoints. Prove zero connect API requests/upgrades, no form action, and no frame/worker/object execution reached those endpoints. Console/rejected promises alone are insufficient. Resource loads intentionally permitted by script/img/style sources are separately identified, not miscounted as forbidden API traffic.
3. Run explicit private positive controls through a probe-only onSend override. For connect attempts, replace `connect-src 'none'` by `connect-src http: https: ws: wss:` and assert the same attempts reach the counting mock. Merely deleting connect-src is insufficient because default-src still blocks them. For a form-action pair, both probe responses use `sandbox allow-scripts allow-forms`; one retains `form-action 'none'` and must block, and the other uses `form-action http: https:` and must reach the mock. This isolates form-action from sandbox's independent form prohibition. For frame/worker/object controls, relax any applicable fallback or origin restriction explicitly in the private control and record the exact weakened policy; do not attribute a still-blocked attempt to the wrong directive. Also separately remove sandbox while keeping connect restrictions, and demonstrate the origin/storage distinction (normal preview document has opaque `self.origin` and storage access fails; unsandboxed control has the app origin). A false-negative counter setup fails the audit.
4. Navigate the preview's own tab to a foreign loopback page (different port, hence different origin). Under the original document policy this navigation is allowed. That page attempts a simple POST and a WebSocket upgrade to the app. Server-side counters must show the guard rejects both with exact 403, zero protected-handler calls, and zero bridges. A safe request may reach the app but cannot gain CORS response access; do not claim all cross-origin GETs are blocked.
5. Run an independent positive control for the guard by making an equivalent same-origin or explicitly allowed action/upgrade, proving protected counters and handshake observers work.

Output `result.json` contains `passed`, `browserVersion`, `animationProgress`, per-attempt forbidden request/upgrade/handler counts, positive-control counts, and navigation action/handshake statuses. Any required assertion failure exits nonzero. The audit report links this output and the exact script/revision used. Keep internal gates and evidence out of the product UI.

## 12. Documentation and release deliverables

### 12.1 Canonical pages

Update `docs/config.md` and `docs/config.html` together:

- Extend **External path access** with the rule that transcript local-file links and Markdown images use a read-only view served by the session-owning machine; workspace-relative reads stay in that workspace and absolute external reads need an allowed root. Existing global/project root merging applies.
- State supported HTML/SVG, PDF, raster image, and text/source categories; the `64 MB` (`67,108,864` bytes) maximum; unsupported/nonregular rejection; no directory browsing or writes; self-contained HTML works; sibling local HTML assets do not resolve; remote PDFs transfer whole without range seeking. Previewed SVG/HTML runs animation under the restricted policy and may load allowed remote resources; do not promise a blanket network ban or prevention of self-navigation.
- Add **Browser origins** (`browser-origins` anchor in both surfaces) documenting the exact schema, normalized full-origin examples, optional/[] semantics, explicit clearing via [], no env override, no project-local support, and config-file/API management (no new Settings editor).
- State unsafe methods and all socket upgrades are checked whenever Origin is present; absent-Origin nonbrowser clients keep working; `Origin: null` is rejected; safe reads retain existing CORS behavior. Distinguish this key from Vite's `allowedHosts`.
- Give both proxy cases: preserving Host + correct XFP requires no list; rewriting Host requires the public scheme/authority/port on the receiving machine. Give a JSON example with `https://pi.example` and `https://pi.example:8443`.
- Add restart guidance to the page's existing restart list: changed allowedOrigins and installing this guard require web/API reload/restart **and a manual session-daemon restart**. Desired config responses do not prove activation.
- Document the DNS-rebinding residual without implying this feature implements host admission.

Insert this exact Markdown configuration-matrix row (and equivalent cells in HTML):

```text
| Extra trusted browser origins | `allowedOrigins` | — | Global (machine) | Not supported locally | Restart web/API and session daemon on that machine |
```

Add `allowedOrigins` to the explanatory inventory of selected-machine-safe global config keys because the alias/proxy API can carry it, while stating its management is config/API-only in this feature. Keep existing gateway-owned host/port/allowedHosts claims accurate.

Update `docs/machines.html` under existing machine-header/trust guidance, linking to `config#browser-origins`:

- Default federation sends no browser Origin.
- A custom configured Origin equal to the remote's effective request origin works with an empty allowlist.
- A different custom configured valid Origin must appear in that remote's allowedOrigins, and both remote web/API and session daemon must restart after a change.
- File previews use the owning machine's path policy; an offline remote retains existing gateway errors.

No README or new public documentation page is needed.

### 12.2 Changeset

Add `.changeset/local-file-link-preview.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": minor
---

Open local file links in session transcripts as read-only previews for HTML, SVG, PDF, images, and text, including files on remote machines.

Reject cross-origin browser actions and WebSocket connections, and add the machine-global `allowedOrigins` setting for reverse proxies that rewrite the public origin. Restart the web/API process and manually restart the session daemon after updating to activate the protection.
```

Do not manually edit CHANGELOG or bump package versions. The implementation adds a capability and config key, so the approved bump type is `minor`. Publication remains the separate standard GitHub Actions release workflow.

### 12.3 Handoff note

The implementation's completion/review handoff must include:

> The browser-origin guard is also loaded by the long-lived session daemon. Manually restart `pi-webui-sessiond.service` to activate this change; ordinary UI/API autoreload is insufficient. Changes to `allowedOrigins` require restarting both the web/API process and session daemon on that machine.

For this development setup the explicit daemon command is `systemctl --user restart pi-webui-sessiond.service`; the UI/API owner is `pi-webui-ui-dev.service`. Record the requirement; do not restart services as part of authoring or testing the feature. Runtime sessions survive an ordinary UI/API restart according to the existing split-owner model.

## 13. Ordered implementation tasks and verification

Use one plan with the following sequential tasks. Each task includes its meaningful regression cases before production changes; no parallel edits to the same shared boundary are required.

1. **Shared contracts and config round-trip.** Add file kinds/origin normalizer, config type/parser/serializer, both server projections and update semantics, browser parser, settings preservation, and project-local no-effect coverage. Run the focused shared/config/parser/draft tests. This establishes the valid startup snapshot contract before a guard consumes it.
2. **Origin guard in both compositions.** Add predicate/hook, gateway startup read, daemon edge factory and production usage. Complete gateway/daemon HTTP and socket matrices, activation tests, two-hop test, and machine configured-header tests. Keep actual session runtime startup/listener ownership intact.
3. **Authorized file service.** Add the default/injected opener and error taxonomy. Complete real-file and platform-matrix tests, including bounded FIFO and explicit race barriers. Do not weaken the existing path access policy.
4. **HTTP streaming and federation.** Add reply adapter, local view registration, exact headers/errors, federated GET and proxy response-header allowlist. Complete reply/route/federation/remote-stream tests before exposing generated links.
5. **Client recognition and DOM lifecycle.** Add URL helper/resolver, sanitizer survival, per-element rewrite/restoration, all five ChatView bindings, and memoized app binding. Complete resolver/sanitizer/helper/DOM/component boundary cases. Audit changed production client URL-bearing code against AGENTS.md.
6. **Operator docs and release fragment.** Update the three canonical pages, insert config-matrix row, add exact minor Changeset and restart handoff note. Inspect paired Markdown/HTML claims and links.
7. **Integrated verification and browser evidence.** Run the focused changed test files, then typecheck/lint and `verify:fast`; run the browser audit with its positive controls and archive evidence. Review the final diff for unchanged transcript/cache semantics, route read-only scope, explicit handles/cleanup, and both independent guard installations.

Implementation verification commands, in order (replace placeholders with the actual changed files; do not run full suites concurrently):

```text
npm test -- --run <changed test files from section 10>
npm run typecheck
npx eslint <changed TypeScript and audit-script files>
npm run verify:fast
git diff --check
node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium <executable> --output-dir <audit-directory>
```

Use `npm run verify` for a subsequent final merge/release gate. A timeout in a loaded suite must be rerun as the exact file with `npm run test:serial -- --run <file>` on an idle machine before being classified as a code failure. Missing browser tooling must be reported as missing browser evidence, not replaced by header equality alone.

At specification-authoring time these are future implementation checks; this document does not claim they have run or that the feature exists.

## 14. Decisions resolving design ambiguities

1. **No additional feature UI.** The only new browser behavior is transcript DOM rewriting and new-tab/direct-image navigation; allowedOrigins is config/API-managed with preservation through existing Settings drafts.
2. **Strict origins with one root-slash spelling.** A single optional terminal `/` denotes no path and normalizes away; any other path, normalized-away path, delimiter, credential marker, wildcard, or malformed item rejects. Normalize default ports/host case/IDNs and deduplicate without broadening full-origin equality.
3. **Explicit clearing, safe omission.** Explicit [] clears allowedOrigins; omission in either HTTP update preserves it, including global PUT for this new key only. Missing file key means no extra origins. No env flag or project-local trust is added.
4. **Small daemon extraction.** An import-safe HTTP-edge factory installs the real guard and WebSocket plugin. Runtime creation, migration ordering, routes, listener, session ownership, and signal cleanup remain in sessiond's existing startup flow; tests exercise the production edge with fake runtime services.
5. **Both terminal bridge implementations.** Gateway socket coverage uses the existing workspace-terminal path through local daemon bridging and nonlocal machine bridging. Daemon direct exposure uses `/terminals/:id/socket`; no nonexistent gateway endpoint is added to satisfy a matrix.
6. **Lossless single decode.** Percent escapes decode once only when valid UTF-8 byte sequences round-trip; malformed input stays entirely raw. Query removal precedes extension recognition; fragments remain client-only. No UNC extension of the approved path families is introduced.
7. **Exact cwd and directory candidates.** Cwd itself becomes `path=.` and receives 415; cwd-child extensionless targets also reach the server's explicit kind error. Root and Windows-root comparison keep their separator. Near-prefixes never strip.
8. **Independent response owner.** A small file-view reply adapter counts bytes before clean EOF and starts reads only after final response headers are ready. Legitimate zero-length files have a no-read EOF path; post-fstat zero truncation aborts. Success never advertises a mutable fixed length.
9. **Fail-closed platform details.** Linux uses the granting root and real opened descriptor path; lookup failure denies. Windows requires usable matching dev/ino, not equality of two unknown/zero inode values. Ancestor and documented Windows replacement races remain explicit residuals.
10. **Pre-stream infrastructure taxonomy.** The design's five FileViewError statuses remain exact; malformed query shape/NUL, missing project/workspace, and unexpected infrastructure failures have explicit boundary messages. Only unexpected errors use generic plain-text 500. Remote transport failures retain existing envelopes.
11. **Headers beyond the design minimum.** File-view errors also use no-store/no-referrer. Only document success has CSP. Successful previews omit cache validators/range/disposition and fixed length; deterministic error strings may use Fastify's correct length. Existing compression is preserved and counts original file bytes.
12. **Startup trust is a snapshot.** Gateway reads once via injected config service; daemon uses its existing startup effective config. A valid explicit allowlist can match even when request-origin derivation is unavailable; malformed present Origin can never be treated as absent. Both owners must restart for activation.
13. **Read-only release scope.** No range/sibling-asset server, prompt convention, authentication feature, DNS-rebinding defense, README growth, version bump, or publication action is bundled into this plan. The user-visible implementation receives the approved minor Changeset and a manual daemon-restart note.
