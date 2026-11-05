# Local File Link Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax; leave every box unticked because the controller pins this document's digest.

**Goal:** Make transcript file links and images open an authorized, read-only view on the session-owning machine, and reject foreign browser actions and WebSocket upgrades at both HTTP owners.

**Architecture:** Keep classification and origin normalization pure and shared, consume the existing coordinated config service, and install independent startup guards in the gateway and an import-safe daemon HTTP factory. Authorize through the existing Files policy, pin and measure one file handle, and transfer its bounded stream to a dedicated reply owner before federating the read. Enhance only live FormattedText DOM attributes using an injected, memoized workspace resolver; retain written Markdown and cache contents.

**Tech Stack:** TypeScript ESM, Node >=22.19.0, Fastify, @fastify/websocket, @fastify/compress, node:fs FileHandle/ReadStream, Lit, Marked, Vitest/jsdom, ws/raw Chromium CDP, Changesets.

## Global Constraints

- Build PI WEBUI-owned browser paths as application-relative references without a leading slash, for example `api/...` and `pi-webui-plugins/...`.
- Encode every dynamic path segment with `encodeURIComponent`; encode query values, using `URLSearchParams` for multi-field queries.
- Resolve each reference exactly once at the browser boundary: ordinary JSON HTTP paths go to `request()`, direct browser APIs receive URLs from helpers backed by `resolveAppUrl()`, and WebSockets use `resolveAppWebSocketUrl()`.
- Name helpers returning unresolved application references with a `Path` suffix and helpers returning browser-ready absolute values with a `Url` suffix.
- Plugin module references must go through `resolvePluginModuleUrl()`. Its leading-slash handling is the documented rolling-compatibility exception; do not introduce other leading-root app references.
- Pre-JavaScript HTML assets use Vite `%BASE_URL%`; PWA manifest references stay `./`-relative. External links, data URLs, and module-relative plugin assets are not application paths.
- To assess deviations, search production client code for raw `fetch`, `WebSocket`, `XMLHttpRequest`, URL-bearing DOM attributes, and leading `/api` or `/pi-webui-plugins` literals. Every app-owned result must follow one of the boundaries above.
- Published nested deployments require a canonical trailing slash; the reverse proxy must redirect a slashless prefix before serving the app.
- MAX_FILE_VIEW_BYTES = 67108864; export `MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024` and `MAX_FILE_VIEW_LABEL = "64 MB"`; exactly `67_108_864` bytes is allowed.
- The complete single-line document CSP is exactly `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'` with no trailing semicolon.
- A successful mutable file stream has no fixed `Content-Length`. Growth is bounded; early EOF and read failure abort the HTTP response. Every acquired handle is eventually closed.
- Explicit `allowedOrigins: []` clears the trust; omission in either HTTP update preserves it, including global PUT for this new key only; missing file key means no extra origins; no env flag or project-local trust is added.
- There is no `PI_WEBUI_ALLOWED_ORIGINS` override, CLI switch, project-local key, or machine-record schema addition.
- Applying a changed `allowedOrigins` requires restarting both web/API and session daemon on the machine whose requests are being checked; each owner copies its startup list once; desired config responses do not prove activation.
- The browser-origin guard is also loaded by the long-lived session daemon. Manually restart `pi-webui-sessiond.service` to activate this change; ordinary UI/API autoreload is insufficient. Changes to `allowedOrigins` require restarting both the web/API process and session daemon on that machine. Record this handoff; do not restart services while implementing or testing.
- The preview route is read-only and has no mutation counterpart. Only GET is registered; retain Fastify's default bodyless HEAD alias and ordinary router behavior for other methods.
- Route authorization is identical to the Files panel's authorization: `resolveWorkspacePathAccessTarget` and the same effective global-plus-project path-access configuration; no new roots or permissions are inferred from a URL.
- Authorization resolves a name; open pins a handle; `fstat` measures that handle; reads use that handle. A second pathname-based stream is forbidden.
- Do not edit README, CHANGELOG, package versions, the approved design, the approved specification, runtime data, or unrelated source; add exactly one minor Changeset `.changeset/local-file-link-preview.md` with the approved text. Publication is a separate GitHub Actions workflow.
- Use focused `npm test -- --run <actual test-file paths>` commands first; never run full suites concurrently with another full suite, heavy job, parallel agent, or subsession. Rerun a loaded-suite timeout with `npm run test:serial -- --run <actual failing file>` on an idle machine before classifying it.
- No new runtime dependencies, barrel exports, plugin API, general DI framework, download UI, sibling-asset server, range support, video/audio preview, prompt changes, transcript writes, authentication redesign, or DNS-rebinding defense.
- Tests use independently literal expected kinds, MIME values, caps, CSP, statuses, and bodies; do not import a production constant as its own expected value. Use real DOM components and explicit phase barriers; no arbitrary TemplateResult.values extraction or scheduling sleeps.

## Task 1: Establish shared file kinds and canonical browser origins

**Implementer tier:** Standard
**Lane:** shared-config
**Dependencies:** none

**Files:**

- Create: `src/shared/fileViewTypes.ts`
- Create: `src/shared/browserOrigins.ts`
- Test: `src/shared/fileViewTypes.test.ts`
- Test: `src/shared/browserOrigins.test.ts`

**Interfaces:**

- Consumes existing `imageMimeTypeForPath(path: string): string | undefined` from `src/server/workspaces/imagePreviewService.ts` in tests only.
- Produces `FileViewKind = "document" | "pdf" | "image" | "text"`, `MAX_FILE_VIEW_BYTES: number = 64 * 1024 * 1024`, `MAX_FILE_VIEW_LABEL = "64 MB"`, and `fileViewKindForPath(path: string): FileViewKind | undefined` from `src/shared/fileViewTypes.ts`.
- Produces `normalizeBrowserOrigin(value: string): string | undefined` from `src/shared/browserOrigins.ts`; returns normalized URL.origin, never an effect or a config read.

- [ ] **Step 1: Add independently specified classification and origin tests.** The canonical parameterized case names from specification 10.1–10.2 are `classifies <extension> as <kind>`, `normalizes <origin spelling>`, and `rejects <invalid origin syntax>`; substitute the literal row label for each bracketed parameter in the executable test name. Use the following literal data and assertions; the extension table belongs to this test, not an imported production table.

```ts
// fileViewTypes.test.ts
import { expect, it } from "vitest";
import { fileViewKindForPath, MAX_FILE_VIEW_BYTES, MAX_FILE_VIEW_LABEL } from "./fileViewTypes.js";
import { imageMimeTypeForPath } from "../server/workspaces/imagePreviewService.js";
const kinds = {
  document: ["html", "htm", "svg"], pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"],
  text: ["txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "xml", "yaml", "yml", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "py", "sh", "rs", "go", "java", "c", "h", "cc", "cpp", "hpp", "toml", "ini", "conf"],
} as const;
for (const [kind, extensions] of Object.entries(kinds)) {
  for (const ext of extensions) it(`classifies .${ext} as ${kind}`, () => expect(fileViewKindForPath(`a.${ext}`)).toBe(kind));
}
it("classifies uppercase final extensions on POSIX and Windows paths", () => {
  for (const [path, expected] of [["/a/b.HTML", "document"], ["C:\\a\\b.PDF", "pdf"], ["a/b\\c.PNG", "image"], ["a/b.TSX", "text"]]) expect(fileViewKindForPath(path!)).toBe(expected);
});
it("rejects unknown, extensionless, dotfile-only, trailing-dot and directory paths", () => {
  for (const path of ["a.exe", "Makefile", ".html", "a.", "folder.html/", "folder.svg\\"]) expect(fileViewKindForPath(path)).toBeUndefined();
});
it("uses only the final leaf and does not parse URL suffixes", () => {
  expect(fileViewKindForPath("dir.html/a.txt")).toBe("text");
  expect(fileViewKindForPath("a.html.exe")).toBeUndefined();
  expect(fileViewKindForPath("a.html?x=1")).toBeUndefined();
});
it("has a MIME type for every shared image extension", () => {
  const expected = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
  for (const [ext, mime] of Object.entries(expected)) expect(imageMimeTypeForPath(`a.${ext}`)).toBe(mime);
});
it("exports the exact 64 MB preview cap and label", () => {
  expect(MAX_FILE_VIEW_BYTES).toBe(67_108_864); expect(MAX_FILE_VIEW_LABEL).toBe("64 MB");
});
```

```ts
// browserOrigins.test.ts
import { expect, it } from "vitest";
import { normalizeBrowserOrigin } from "./browserOrigins.js";
it.each([
  ["HTTPS://PI.EXAMPLE:443/", "https://pi.example"], ["http://PI.EXAMPLE:80", "http://pi.example"],
  ["https://pi.example:8443", "https://pi.example:8443"], ["http://[::1]:8808/", "http://[::1]:8808"],
  ["https://bücher.example", "https://xn--bcher-kva.example"], [" https://pi.example/ ", "https://pi.example"],
])("normalizes %s", (input, expected) => expect(normalizeBrowserOrigin(input)).toBe(expected));
it.each([
  "null", "", "*", "/relative", "//host", "file://host", "https://u:p@host", "https://@host",
  "https://host/a", "https://host/a/..", "https://host//", "https://host?q=1", "https://host?",
  "https://host#part", "https://host#", "https://host\\", "https://ho st", "https://ho\tst", "https://ho\nst",
  "https://a,https://b", "https://a https://b", "http://host:99999", "http://host:bad", "http:///host", "https://*.example",
])("rejects %s", (input) => expect(normalizeBrowserOrigin(input)).toBeUndefined());
```

- [ ] **Step 2: Run `npm test -- --run src/shared/fileViewTypes.test.ts src/shared/browserOrigins.test.ts`.** Confirm missing new modules first; after adding exports, the assertions must detect omitted mappings and normalized-away origin syntax.
- [ ] **Step 3: Implement both pure modules with private tables and strict pre-normalization checks.**

```ts
// src/shared/fileViewTypes.ts
export type FileViewKind = "document" | "pdf" | "image" | "text";
export const MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_VIEW_LABEL = "64 MB";
const EXTENSIONS: Readonly<Record<FileViewKind, readonly string[]>> = {
  document: [".html", ".htm", ".svg"], pdf: [".pdf"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"],
  text: [".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xml", ".yaml", ".yml", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".py", ".sh", ".rs", ".go", ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".toml", ".ini", ".conf"],
};
export function fileViewKindForPath(path: string): FileViewKind | undefined {
  const leaf = path.split(/[\\/]/u).at(-1) ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || dot === leaf.length - 1) return undefined;
  const ext = leaf.slice(dot).toLowerCase();
  return (Object.keys(EXTENSIONS) as FileViewKind[]).find((kind) => EXTENSIONS[kind].includes(ext));
}
// src/shared/browserOrigins.ts
export function normalizeBrowserOrigin(value: string): string | undefined {
  const input = value.trim();
  if (/[\s\u0000-\u001f\u007f\\?#@*,]/u.test(input) || !/^https?:\/\/[^/]+\/?$/iu.test(input)) return undefined;
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}
```

- [ ] **Step 4: Rerun the focused command and `npx eslint src/shared/fileViewTypes.ts src/shared/browserOrigins.ts src/shared/fileViewTypes.test.ts src/shared/browserOrigins.test.ts`.** Require all assertions passing and no lint errors.
- [ ] **Step 5: Commit.**

```bash
git add src/shared/fileViewTypes.ts src/shared/browserOrigins.ts src/shared/fileViewTypes.test.ts src/shared/browserOrigins.test.ts
git commit -m "feat(shared): define file preview kinds and exact browser origins"
```

## Task 2: Persist the machine-global origin list and prove project-local isolation

**Implementer tier:** Standard
**Lane:** shared-config
**Dependencies:** Task 1

**Files:**

- Modify: `src/shared/apiTypes.ts:489-516`
- Modify: `src/config.ts:205-229`, `src/config.ts:424-495`, `src/config.ts:900-920`
- Test: `src/config.test.ts`
- Test: `src/server/workspaces/projectPiWebUiConfig.test.ts`

**Interfaces:**

- Consumes `normalizeBrowserOrigin(value: string): string | undefined` from Task 1.
- Produces `PiWebUiConfigValues.allowedOrigins?: string[]` (inherited by `PiWebUiConfig`, effective config, and both response projections); `PiWebUiConfigEnvOverrides` has no new member.
- Produces `parseAllowedOriginsConfig(value: unknown, source: string): string[]`, which normalizes/deduplicates preserving first order and throws the exact validation string below.
- Retains existing `loadPiWebUiConfig(options?: LoadOptions): LoadedPiWebUiConfig`, `savePiWebUiConfig(config: PiWebUiConfig, options?: SavePiWebUiConfigOptions): LoadedPiWebUiConfig`, and effective-config spread behavior.
- Consumes existing project functions `loadProjectPiWebUiConfig(projectPath: string): Promise<LoadedProjectPiWebUiConfig>`, `loadEffectiveProjectPathAccess(projectPath: string, globalConfig: PiWebUiConfig): Promise<PiWebUiPathAccessConfig | undefined>`, and `loadEffectiveProjectUploadsConfig(projectPath: string, globalConfig: PiWebUiConfig): Promise<PiWebUiUploadsConfig>`; produces regression coverage only for these functions, no project schema addition.

- [ ] **Step 1: Extend the existing config tests using their `configPath`, `testOptions()`, `writeProjectConfig(value: unknown): Promise<void>`, and project fixtures.** Add `parseAllowedOriginsConfig` and `type PiWebUiConfig` to the config test's imports; import `loadEffectiveProjectPathAccess` and `loadEffectiveProjectUploadsConfig` explicitly in the project test. The rejection matrix implements specification 10.17's `rejects <invalid allowedOrigins config value> without weakening the field`, substituting each independent row label. Keep the following invalid list independent and exercise every item through both load and save.

```ts
it("round-trips normalized allowedOrigins and preserves unrelated keys", async () => {
  await writeFile(configPath, JSON.stringify({ future: { enabled: true }, port: 9000 }));
  const input = { port: 9000, allowedOrigins: ["HTTPS://PI.EXAMPLE:443/", "https://pi.example", "http://pi.example:8080/"] };
  savePiWebUiConfig(input, testOptions());
  expect(loadPiWebUiConfig(testOptions()).config).toEqual({ port: 9000, allowedOrigins: ["https://pi.example", "http://pi.example:8080"] });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ future: { enabled: true }, port: 9000, allowedOrigins: ["https://pi.example", "http://pi.example:8080"] });
});
it("keeps absent and explicit empty allowedOrigins distinct in stored config", async () => {
  savePiWebUiConfig({}, testOptions());
  expect(loadPiWebUiConfig(testOptions()).config).not.toHaveProperty("allowedOrigins");
  savePiWebUiConfig({ allowedOrigins: [] }, testOptions());
  expect(JSON.parse(await readFile(configPath, "utf8"))).toHaveProperty("allowedOrigins", []);
  savePiWebUiConfig({}, testOptions());
  expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("allowedOrigins");
});
const invalidOriginConfigs: unknown[] = [null, true, 7, {}, "https://host", [1], ["https://host", false],
  ...["null", "", "*", "/relative", "//host", "ftp://host", "https://u:p@host", "https://@host", "https://host/a", "https://host/a/..", "https://host//", "https://host?", "https://host?q=1", "https://host#", "https://host#p", "https://host\\", "https://ho st", "https://ho\tst", "https://a,https://b", "http://host:99999"].map((s) => [s])];
it.each(invalidOriginConfigs.map((value, index) => ({ value, index })))("rejects invalid allowedOrigins config value $index without weakening the field", async ({ value }) => {
  const message = `PI WEBUI config allowedOrigins must be an array of absolute http/https origins without credentials, paths, queries, or fragments: ${configPath}`;
  await writeFile(configPath, JSON.stringify({ allowedOrigins: value }));
  expect(() => loadPiWebUiConfig(testOptions())).toThrow(message);
  expect(() => parseAllowedOriginsConfig(value, configPath)).toThrow(message);
  // Exercise save validation with deliberately untyped input without lying about the production type.
  const config = Object.assign({}, { allowedOrigins: value });
  expect(() => savePiWebUiConfig(config as PiWebUiConfig, testOptions())).toThrow(message);
});
it("ignores an apparent allowedOrigins environment override", () => {
  savePiWebUiConfig({ allowedOrigins: ["https://pi.example"] }, testOptions());
  const options = { ...testOptions(), env: { ...testOptions().env, PI_WEBUI_ALLOWED_ORIGINS: "https://attacker.example" } };
  expect(effectivePiWebUiConfig(options).config.allowedOrigins).toEqual(["https://pi.example"]);
  savePiWebUiConfig({}, testOptions());
  expect(effectivePiWebUiConfig(options).config).not.toHaveProperty("allowedOrigins");
});
// Add to projectPiWebUiConfig.test.ts; existing file-local writeProjectConfig is the fixture writer.
it("does not apply a project-local allowedOrigins key", async () => {
  await writeProjectConfig({ version: 1, allowedOrigins: ["https://attacker.example"], pathAccess: { allowedPaths: ["/project-sdk"] }, uploads: { defaultFolder: "incoming" } });
  expect((await loadProjectPiWebUiConfig(projectPath)).config).toEqual({ version: 1, pathAccess: { allowedPaths: ["/project-sdk"] }, uploads: { defaultFolder: "incoming" } });
  expect(await loadEffectiveProjectPathAccess(projectPath, { allowedOrigins: ["https://pi.example"], pathAccess: { allowedPaths: ["/global-sdk"] } })).toEqual({ allowedPaths: ["/global-sdk", "/project-sdk"] });
  expect(await loadEffectiveProjectUploadsConfig(projectPath, {})).toEqual({ defaultFolder: "incoming" });
});
```

- [ ] **Step 2: Run `npm test -- --run src/config.test.ts src/server/workspaces/projectPiWebUiConfig.test.ts`.** Record the missing field/parser failures; the project-isolation control may already pass and needs no manufactured failure.
- [ ] **Step 3: Add the type and parser, then insert the key in all three existing persistence stages.** Add the browser-safe import with `.js` in server code. Add the exact shared-type comment:

```ts
/** Extra exact browser origins trusted by this machine; both HTTP owners restart. */
allowedOrigins?: string[];
```

```ts
export function parseAllowedOriginsConfig(value: unknown, source: string): string[] {
  const message = `PI WEBUI config allowedOrigins must be an array of absolute http/https origins without credentials, paths, queries, or fragments: ${source}`;
  if (!Array.isArray(value)) throw new Error(message);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(message);
    const origin = normalizeBrowserOrigin(item);
    if (origin === undefined) throw new Error(message);
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}
```

Insert `delete existing["allowedOrigins"];` next to `allowedHosts` deletion in `savePiWebUiConfig`; insert `...(config.allowedOrigins !== undefined ? { allowedOrigins: config.allowedOrigins } : {}),` in `piWebUiConfigRecord`; insert `...(value["allowedOrigins"] !== undefined ? { allowedOrigins: parseAllowedOriginsConfig(value["allowedOrigins"], path) } : {}),` in `parsePiWebUiConfig`'s ordinary fatal parse object. Keep this outside tolerant model-tier/utility catches. The effective-config existing spread carries it; do not add env processing or change project parsing.

- [ ] **Step 4: Rerun the focused command and `npm run typecheck`.** Confirm arrays are fresh, unknown raw keys survive, and existing replacement semantics remove a stale allowedOrigins file key.
- [ ] **Step 5: Commit.**

```bash
git add src/shared/apiTypes.ts src/config.ts src/config.test.ts src/server/workspaces/projectPiWebUiConfig.test.ts
git commit -m "feat(config): persist strict machine-global browser origins"
```

## Task 3: Round-trip and preserve origins through both server config APIs

**Implementer tier:** Standard
**Lane:** shared-config
**Dependencies:** Task 2

**Files:**

- Modify: `src/server/configRoutes.ts:1-29`, `src/server/configRoutes.ts:105-259`
- Test: `src/server/configRoutes.test.ts`

**Interfaces:**

- Consumes `PiWebUiConfigValues.allowedOrigins?: string[]` and `parseAllowedOriginsConfig(value: unknown, source: string): string[]` from Task 2.
- Retains `PiWebUiConfigService = { read(): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>; write(config: PiWebUiConfigValues): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>; update(mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse> }`.
- Produces private `parseConfigRequest(value: unknown, agentPathHost: AgentPathHost = "current", allowedOriginsSource = "request"): PiWebUiConfig`; `parsePiWebUiConfigResponseValues(value: unknown, agentPathHost: AgentPathHost, source: string): PiWebUiConfigValues` passes source through.
- Retains exports `parsePiWebUiConfigResponseBody(value: unknown, source?: string): PiWebUiConfigResponse`, `parseSelectedMachineConfigRequest(value: unknown, agentPathHost?: AgentPathHost): PiWebUiConfig`, `selectedMachineConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse`, and `mergeSelectedMachineConfig(current: PiWebUiConfigValues, patch: PiWebUiConfigValues): PiWebUiConfig`; all preserve populated/empty lists.

- [ ] **Step 1: Extend the existing real route fixture and snapshot/redaction tests.** Existing `app`, `savedConfig`, `service`, `responseFor(config, exists)` are local fixtures; add the tests below to that file. The cross-product's canonical specification 10.18 name is `rejects <invalid origin payload> on <config alias> before persistence`; substitute payload and alias labels per row.

```ts
it.each(["/api/config", "/api/machines/local/config"])("exposes normalized allowedOrigins in both config response projections at %s", async (url) => {
  const put = await app.inject({ method: "PUT", url, payload: { config: { allowedOrigins: ["HTTPS://PI.EXAMPLE:443/", "https://pi.example"] } } });
  expect(put.statusCode).toBe(200);
  for (const response of [put, await app.inject({ method: "GET", url })]) {
    const value = response.json<PiWebUiConfigResponse>();
    expect(value.config.allowedOrigins).toEqual(["https://pi.example"]);
    expect(value.effectiveConfig.allowedOrigins).toEqual(["https://pi.example"]);
    expect(value.envOverrides).not.toHaveProperty("allowedOrigins");
  }
});
it("accepts allowedOrigins in selected-machine patches and preserves it on unrelated patches", async () => {
  await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { allowedOrigins: ["https://pi.example"] } } });
  await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { pathAccess: { allowedPaths: ["/tmp"] } } } });
  expect(savedConfig.allowedOrigins).toEqual(["https://pi.example"]);
  expect(service.update).toHaveBeenCalledTimes(2);
});
it("preserves omitted allowedOrigins on a global update and clears only with an explicit empty list", async () => {
  savedConfig = { port: 8808, allowedOrigins: ["https://pi.example"] };
  await app.inject({ method: "PUT", url: "/api/config", payload: { config: { host: "127.0.0.1" } } });
  expect(savedConfig).toEqual({ host: "127.0.0.1", allowedOrigins: ["https://pi.example"] });
  const clear = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedOrigins: [] } } });
  expect(savedConfig.allowedOrigins).toEqual([]);
  expect(clear.json<PiWebUiConfigResponse>().effectiveConfig.allowedOrigins).toEqual([]);
});
for (const [alias, prefix] of [["/api/config", "PI WEBUI config"], ["/api/machines/local/config", "PI WEBUI selected-machine config"]]) {
  it.each([null, "https://host", ["null"], ["https://host/a/.."], ["https://host?"], ["https://host#"], ["https://@host"], [false]].map((value, index) => ({ value, index })))(`rejects invalid origin payload $index on ${alias} before persistence`, async ({ value }) => {
    const response = await app.inject({ method: "PUT", url: alias!, payload: { config: { allowedOrigins: value } } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: `${prefix} allowedOrigins must be an array of absolute http/https origins without credentials, paths, queries, or fragments: request` });
    expect(service.update).not.toHaveBeenCalled(); expect(service.write).not.toHaveBeenCalled();
  });
}
it("parses allowedOrigins in server-side remote responses using the response source", () => {
  for (const allowedOrigins of [["HTTPS://PI.EXAMPLE:443/"], []]) {
    const raw = responseFor({ allowedOrigins }, true);
    const parsed = parsePiWebUiConfigResponseBody(raw, "Remote machine config response");
    expect(parsed.config.allowedOrigins).toEqual(allowedOrigins.length ? ["https://pi.example"] : []);
    expect(parsed.effectiveConfig.allowedOrigins).toEqual(parsed.config.allowedOrigins);
  }
  const raw = responseFor({}, true);
  for (const field of ["config", "effectiveConfig"] as const) {
    expect(() => parsePiWebUiConfigResponseBody({ ...raw, [field]: { allowedOrigins: ["null"] } }, "Remote machine config response")).toThrow("PI WEBUI config allowedOrigins must be an array of absolute http/https origins without credentials, paths, queries, or fragments: Remote machine config response");
  }
});
it("retains allowedOrigins through committed-snapshot projection and speech redaction", () => {
  const config = { allowedOrigins: ["https://pi.example"] };
  const snapshot = { loaded: { path: "/tmp/config.json", exists: true, config }, speechInputRevision: "revision" };
  const response = redactSpeechInputConfigResponse(piWebUiConfigResponseFromSnapshot(snapshot, { env: {} }));
  expect(response.config.allowedOrigins).toEqual(["https://pi.example"]);
  expect(response.effectiveConfig.allowedOrigins).toEqual(["https://pi.example"]);
  expect(response.config).not.toHaveProperty("speechInput");
});
```

Also add populated `allowedOrigins` to the existing full speech-secret snapshot fixture before redaction and independently assert it remains in both redacted fields. This exercises removal of an actual speech subtree, rather than only the early-return branch.

- [ ] **Step 2: Run `npm test -- --run src/server/configRoutes.test.ts`.** Expect failures for selected-key rejection, dropped projections, omission replacement, and incorrect remote source.
- [ ] **Step 3: Implement through the existing coordinator and projections.** Import `parseAllowedOriginsConfig`, add `"allowedOrigins"` to `SELECTED_MACHINE_CONFIG_KEYS`, extend the private parser's third argument, and add these expressions at the named boundaries:

```ts
// Inside global service.update callback, after ...requested:
...(requested.allowedOrigins === undefined && current.allowedOrigins !== undefined
  ? { allowedOrigins: [...current.allowedOrigins] } : {}),
// Inside parseConfigRequest:
if (value["allowedOrigins"] !== undefined) config.allowedOrigins = parseAllowedOriginsConfig(value["allowedOrigins"], allowedOriginsSource);
// Inside parsePiWebUiConfigResponseValues:
const parsed = parseConfigRequest(value, agentPathHost, source);
// Inside pickSelectedMachineConfig's return:
...(config.allowedOrigins !== undefined ? { allowedOrigins: [...config.allowedOrigins] } : {}),
```

Keep speech preservation, response-from-committed-snapshot, busy/move error mapping, and all other keys' existing replacement/patch semantics. `[]` reaches the defined branch and clears. `null` reaches the parser and fails.

- [ ] **Step 4: Rerun `npm test -- --run src/server/configRoutes.test.ts` and `npm run typecheck`.** Confirm malformed values never reach update and source-specific errors remain exact.
- [ ] **Step 5: Commit.**

```bash
git add src/server/configRoutes.ts src/server/configRoutes.test.ts
git commit -m "feat(config): preserve browser origins across gateway and machine APIs"
```

## Task 4: Preserve origins through browser parsing and gateway settings drafts

**Implementer tier:** Standard
**Lane:** shared-config
**Dependencies:** Task 1, Task 2, Task 3

**Files:**

- Modify: `src/client/src/api/parsers.ts:1-100`, `src/client/src/api/parsers.ts:1965-2030`
- Modify: `src/client/src/components/settings/settingsConfigDraft.ts:171-186`
- Test: `src/client/src/api/parsers.test.ts`
- Test: `src/client/src/components/settings/settingsConfigDraft.test.ts`

**Interfaces:**

- Consumes `normalizeBrowserOrigin(value: string): string | undefined` from Task 1 and `PiWebUiConfigValues.allowedOrigins?: string[]` from Task 2; server response fields established in Task 3 remain `config` and `effectiveConfig`.
- Produces private `optionalAllowedOrigins(value: unknown): string[] | undefined`, consumed by existing private `parsePiWebUiConfigValues(value: unknown): PiWebUiConfigValues`.
- Retains `parsePiWebUiConfigResponse(value: unknown): PiWebUiConfigResponse`, `gatewayServerConfigFromDraft(draft: GatewayServerConfigDraft, baseConfig?: PiWebUiConfigValues): PiWebUiConfigValues`, and `machineAccessConfigPatchFromDraft(draft: MachineAccessConfigDraft): PiWebUiConfigValues`; no new editor/draft field.

- [ ] **Step 1: Add browser parser and draft regressions using actual response objects.** Use the existing file's valid config-response fixture for required path/exists/envOverrides fields, or this explicit response builder within the new describe block:

```ts
const originsResponse = (config: unknown, effectiveConfig: unknown = config) => ({
  path: "/tmp/config.json", exists: true, config, effectiveConfig,
  envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false },
});
it("accepts optional normalized allowedOrigins in both config and effectiveConfig", () => {
  for (const [input, expected] of [[{}, undefined], [{ allowedOrigins: ["HTTPS://PI.EXAMPLE:443/", "https://pi.example"] }, ["https://pi.example"]], [{ allowedOrigins: [] }, []]] as const) {
    const parsed = parsePiWebUiConfigResponse(originsResponse(input));
    expect(parsed.config.allowedOrigins).toEqual(expected); expect(parsed.effectiveConfig.allowedOrigins).toEqual(expected);
    expect(parsed.envOverrides).not.toHaveProperty("allowedOrigins");
  }
});
it("rejects malformed browser allowedOrigins instead of dropping it", () => {
  const invalid: unknown[] = [null, true, 7, {}, "https://host", [false], ["null"], ["*"], ["//host"], ["file://host"], ["https://@host"], ["https://u:p@host"], ["https://host/a"], ["https://host/a/.."], ["https://host//"], ["https://host?"], ["https://host#"], ["https://host\\"], ["https://ho st"], ["https://ho\tst"], ["https://a,https://b"], ["http://host:99999"]];
  for (const value of invalid) for (const field of ["config", "effectiveConfig"]) {
    expect(() => parsePiWebUiConfigResponse({ ...originsResponse({}), [field]: { allowedOrigins: value } })).toThrow("Invalid PI WEBUI allowedOrigins field");
  }
});
// settingsConfigDraft.test.ts
it("preserves populated allowedOrigins while saving unrelated gateway fields", () => {
  const base = { allowedOrigins: ["https://pi.example"] };
  const result = gatewayServerConfigFromDraft({ host: "127.0.0.1", port: "9000", allowedHostsMode: "all", allowedHostsText: "" }, base);
  expect(result.allowedOrigins).toEqual(["https://pi.example"]);
  expect(result.allowedOrigins).not.toBe(base.allowedOrigins);
  expect(result).toMatchObject({ host: "127.0.0.1", port: 9000, allowedHosts: true });
});
it("preserves explicit empty allowedOrigins without synthesizing an absent field", () => {
  const draft = { host: "", port: "", allowedHostsMode: "list", allowedHostsText: "" } as const;
  const base = { allowedOrigins: [] };
  const result = gatewayServerConfigFromDraft(draft, base);
  expect(result.allowedOrigins).toEqual([]); expect(result.allowedOrigins).not.toBe(base.allowedOrigins);
  expect(gatewayServerConfigFromDraft(draft, {})).not.toHaveProperty("allowedOrigins");
});
it("does not add origin changes to selected-machine file-access patches", () => {
  expect(machineAccessConfigPatchFromDraft({ allowedPathsText: "/tmp", uploadDefaultFolder: "incoming" })).toEqual({ pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "incoming" } });
});
```

- [ ] **Step 2: Run `npm test -- --run src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts`.** Confirm populated origin parsing/preservation fail before production changes.
- [ ] **Step 3: Add the private parser and the optional defensive copy.**

```ts
function optionalAllowedOrigins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new Error("Invalid PI WEBUI allowedOrigins field"); };
  if (!Array.isArray(value)) return fail();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return fail();
    const origin = normalizeBrowserOrigin(item);
    if (origin === undefined) return fail();
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}
// parsePiWebUiConfigValues return:
...optionalField("allowedOrigins", optionalAllowedOrigins(record["allowedOrigins"])),
// preservedGatewayConfigRemainder return:
...(baseConfig.allowedOrigins === undefined ? {} : { allowedOrigins: [...baseConfig.allowedOrigins] }),
```

Import the shared normalizer directly from `../../../shared/browserOrigins` in parsers.ts. Preserve existing envOverrides and selected-machine builder shapes.

- [ ] **Step 4: Rerun the focused command and `npm run typecheck`.** All new and existing parser/draft cases must pass.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/api/parsers.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts
git commit -m "feat(settings): retain machine browser-origin configuration"
```

## Task 5: Implement the exact origin predicate and root request hook

**Implementer tier:** Standard
**Lane:** origin-guard
**Dependencies:** Task 1, Task 4

**Files:**

- Create: `src/server/http/browserOriginGuard.ts`
- Test: `src/server/http/browserOriginGuard.test.ts`

**Interfaces:**

- Consumes `normalizeBrowserOrigin(value: string): string | undefined` from Task 1.
- Produces `BrowserOriginContext = { origin: string | undefined; requestOrigin: string | undefined; allowedOrigins: readonly string[] }` and `isAllowedBrowserOrigin(context: BrowserOriginContext): boolean`.
- Produces `requestOriginFrom(request: FastifyRequest): string | undefined` using Host, first XFP token, then actual socket encryption; never X-Forwarded-Host.
- Produces `registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins?: readonly string[]): void`; it clones/normalizes startup input and throws `Invalid allowedOrigins startup snapshot` on an invalid injected entry.

- [ ] **Step 1: Add predicate and hook tests before the module.** The mismatch table owns specification 10.14's `rejects <origin mismatch or malformed value>` case family; each row substitutes its explicit reason. The following is the executable core; include independent Host/XFP and raw-header mutation tables in this same file, through actual FastifyRequest objects obtained by injection.

```ts
import Fastify, { type FastifyRequest } from "fastify";
import { expect, it } from "vitest";
import { isAllowedBrowserOrigin, registerBrowserOriginGuard, requestOriginFrom } from "./browserOriginGuard.js";
it("allows an absent browser Origin without an inferred request origin", () => {
  expect(isAllowedBrowserOrigin({ origin: undefined, requestOrigin: undefined, allowedOrigins: [] })).toBe(true);
  expect(isAllowedBrowserOrigin({ origin: undefined, requestOrigin: "%%%", allowedOrigins: [] })).toBe(true);
});
it("matches exact normalized origins and explicit allowedOrigins", () => {
  for (const [origin, requestOrigin, allowedOrigins] of [
    ["HTTPS://PI.EXAMPLE:443/", "https://pi.example", []],
    ["http://pi.example:80", "http://pi.example", []],
    ["https://public.example:8443", "http://internal:8808", ["https://public.example:8443/"]],
    ["https://pi.example", undefined, ["https://pi.example"]],
  ] as const) expect(isAllowedBrowserOrigin({ origin, requestOrigin, allowedOrigins })).toBe(true);
});
it.each(["https://pi.test:8808", "http://other.test:8808", "http://pi.test:8809", "null", "", "%%%", "https://u:p@pi.test", "https://pi.test/path", "https://pi.test?", "https://pi.test#", "file://pi.test", "http://a,http://b"])("rejects %s", (origin) => {
  expect(isAllowedBrowserOrigin({ origin, requestOrigin: "http://pi.test:8808", allowedOrigins: ["not-an-origin"] })).toBe(false);
  if (["null", "", "%%%", "https://u:p@pi.test", "https://pi.test/path", "https://pi.test?", "https://pi.test#", "file://pi.test", "http://a,http://b"].includes(origin)) expect(isAllowedBrowserOrigin({ origin, requestOrigin: undefined, allowedOrigins: [origin] })).toBe(false);
});
it("does not derive trust from allowedHosts-shaped patterns", () => {
  expect(isAllowedBrowserOrigin({ origin: "https://evil.pi.example", requestOrigin: "https://pi.example", allowedOrigins: ["*.pi.example", ".pi.example", "*"] })).toBe(false);
});
async function derive(change: (request: FastifyRequest) => void): Promise<unknown> {
  const app = Fastify({ logger: false });
  app.get("/", (request) => { change(request); return { origin: requestOriginFrom(request) ?? null }; });
  try { return (await app.inject({ url: "/", headers: { host: "pi.test:8808" } })).json(); }
  finally { await app.close(); }
}
it("derives the request origin from socket protocol and Host", async () => {
  expect(await derive(() => undefined)).toEqual({ origin: "http://pi.test:8808" });
  expect(await derive((r) => { Object.defineProperty(r.raw.socket, "encrypted", { configurable: true, value: true }); })).toEqual({ origin: "https://pi.test:8808" });
  expect(await derive((r) => { r.headers.host = "[::1]:8808"; })).toEqual({ origin: "http://[::1]:8808" });
});
it("uses only the first forwarded-proto token and ignores forwarded host", async () => {
  for (const [token, origin] of [["https, http", "https://pi.test:8808"], ["bad, https", null], [", https", null], ["", null]] as const) expect(await derive((r) => { r.headers["x-forwarded-proto"] = token; r.headers["x-forwarded-host"] = "foreign.example"; })).toEqual({ origin });
});
it("fails closed on malformed or duplicate Host and present-invalid forwarded proto", async () => {
  for (const host of ["", "a,b", "a b", "a/path", "a?", "a#", "u@a", "a\\b"]) expect(await derive((r) => { r.headers.host = host; })).toEqual({ origin: null });
  expect(await derive((r) => { r.raw.rawHeaders.push("Host", "other.test"); })).toEqual({ origin: null });
  expect(await derive((r) => { delete r.headers.host; })).toEqual({ origin: null });
});
it("treats duplicate or present-invalid Origin as rejection rather than absence", async () => {
  for (const value of ["", "http://pi.test:8808,http://pi.test:8808", ["http://pi.test:8808", "http://pi.test:8808"]]) {
    const app = Fastify({ logger: false }); let calls = 0;
    app.addHook("onRequest", async (r) => { Object.defineProperty(r.headers, "origin", { configurable: true, value }); if (Array.isArray(value)) r.raw.rawHeaders.push("Origin", value[1]!); });
    registerBrowserOriginGuard(app);
    app.post("/", () => { calls++; return {}; });
    try {
      const r = await app.inject({ method: "POST", url: "/", headers: { host: "pi.test:8808" } });
      expect(r.statusCode).toBe(403); expect(r.body).toBe('{"error":"Cross-origin request rejected"}'); expect(calls).toBe(0);
      expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff");
    } finally { await app.close(); }
  }
});
it("guards case-insensitive websocket upgrade tokens before handling", async () => {
  const app = Fastify({ logger: false }); let calls = 0;
  registerBrowserOriginGuard(app); app.get("/", () => { calls++; return {}; });
  try {
    for (const upgrade of ["WebSocket", "h2c, WEBSOCKET"]) expect((await app.inject({ url: "/", headers: { host: "pi.test", origin: "https://foreign.example", upgrade } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/", headers: { origin: "%%%", upgrade: "h2c" } })).statusCode).toBe(200);
    expect(calls).toBe(1);
  } finally { await app.close(); }
});
it("pins a copied startup allowlist and rejects invalid injected snapshots", async () => {
  const input = ["https://public.example"]; const app = Fastify({ logger: false });
  registerBrowserOriginGuard(app, input); input[0] = "https://later.example";
  app.post("/", () => ({}));
  try {
    expect((await app.inject({ method: "POST", url: "/", headers: { origin: "https://public.example" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/", headers: { origin: "https://later.example" } })).statusCode).toBe(403);
  } finally { await app.close(); }
  const invalid = Fastify({ logger: false });
  try { expect(() => registerBrowserOriginGuard(invalid, ["null"])).toThrow("Invalid allowedOrigins startup snapshot"); }
  finally { await invalid.close(); }
});
```

- [ ] **Step 2: Run `npm test -- --run src/server/http/browserOriginGuard.test.ts`.** Require missing-module failure, then meaningful normalization/denial failures before implementation is complete.
- [ ] **Step 3: Implement the pure predicate and thin root hook.**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { normalizeBrowserOrigin } from "../../shared/browserOrigins.js";
export interface BrowserOriginContext { origin: string | undefined; requestOrigin: string | undefined; allowedOrigins: readonly string[] }
export function isAllowedBrowserOrigin({ origin, requestOrigin, allowedOrigins }: BrowserOriginContext): boolean {
  if (origin === undefined) return true;
  const normalized = normalizeBrowserOrigin(origin);
  if (normalized === undefined) return false;
  if (requestOrigin !== undefined && normalizeBrowserOrigin(requestOrigin) === normalized) return true;
  return allowedOrigins.some((value) => normalizeBrowserOrigin(value) === normalized);
}
function rawHeaderCount(request: FastifyRequest, name: string): number {
  let count = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) if (request.raw.rawHeaders[i]?.toLowerCase() === name) count++;
  return count;
}
export function requestOriginFrom(request: FastifyRequest): string | undefined {
  const host = request.headers.host;
  if (typeof host !== "string" || !host || /[\s\u0000-\u001f\u007f,/?#@\\]/u.test(host) || rawHeaderCount(request, "host") > 1) return undefined;
  const forwarded = request.headers["x-forwarded-proto"];
  let scheme: string;
  if (forwarded !== undefined) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    scheme = (first ?? "").split(",", 1)[0]!.trim().toLowerCase();
    if (scheme !== "http" && scheme !== "https") return undefined;
  } else {
    const socket = request.raw.socket;
    scheme = "encrypted" in socket && socket.encrypted === true ? "https" : "http";
  }
  return normalizeBrowserOrigin(`${scheme}://${host}`);
}
export function registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[] = []): void {
  const snapshot = allowedOrigins.map((value) => {
    const result = normalizeBrowserOrigin(value);
    if (result === undefined) throw new Error("Invalid allowedOrigins startup snapshot");
    return result;
  });
  app.addHook("onRequest", async (request, reply) => {
    const upgrade = request.headers.upgrade;
    const tokens = (Array.isArray(upgrade) ? upgrade.join(",") : upgrade ?? "").split(",");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase()) && !tokens.some((s) => s.trim().toLowerCase() === "websocket")) return;
    const incoming = request.headers.origin;
    const count = rawHeaderCount(request, "origin");
    const invalid = count > 1 || Array.isArray(incoming) || (incoming !== undefined && (incoming.trim() === "" || incoming.includes(","))) || (count > 0 && incoming === undefined);
    if (!invalid && isAllowedBrowserOrigin({ origin: incoming, requestOrigin: requestOriginFrom(request), allowedOrigins: snapshot })) return;
    return reply.code(403).type("application/json; charset=utf-8").header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").send({ error: "Cross-origin request rejected" });
  });
}
```

Narrow the incoming value to `string | undefined` after the array rejection if TypeScript does not carry the boolean alias narrowing. Never convert an invalid present origin to an absent one.

- [ ] **Step 4: Rerun the focused test and `npm run typecheck`.** Verify ordinary GET/HEAD/OPTIONS remain unaffected and there is no config I/O in this module.
- [ ] **Step 5: Commit.**

```bash
git add src/server/http/browserOriginGuard.ts src/server/http/browserOriginGuard.test.ts
git commit -m "feat(security): guard unsafe browser requests and upgrades by exact origin"
```

## Task 6: Install startup guards in the gateway and production daemon edge

**Implementer tier:** Advanced
**Lane:** origin-guard
**Dependencies:** Task 3, Task 5

**Files:**

- Modify: `src/server/app.ts:1-61`, `src/server/app.ts:295-330`
- Create: `src/server/sessiond/sessionDaemonApp.ts`
- Modify: `src/server/sessiond.ts:1-77`
- Test: `src/server/app.originGuard.test.ts`
- Test: `src/server/sessiond/sessionDaemonApp.originGuard.test.ts`

**Interfaces:**

- Consumes `registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins?: readonly string[]): void` from Task 5; `PiWebUiConfigService.read(): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>` and `PiWebUiConfigValues.allowedOrigins?: string[]` from Tasks 2–3.
- Produces `SessionDaemonAppOptions = { allowedOrigins?: readonly string[]; logger?: FastifyServerOptions["logger"]; bodyLimit?: number }` and `createSessionDaemonApp(options?: SessionDaemonAppOptions): Promise<FastifyInstance>`.
- Retains `buildApp(deps?: AppDependencies): Promise<FastifyInstance>`, the existing frozen `daemonEnvironment`, `runSessionDaemonStartup` callback sequencing, runtime/listener ownership, and shutdown handlers.
- Produces file-local `originGateway(allowedOrigins?: string[], socketTarget?: string): Promise<{ app: FastifyInstance; root: string; project: Project; workspace: Workspace; calls: string[]; remoteCalls: string[]; lookup: MockInstance<MachineService["remoteTarget"]>; config: PiWebUiConfigService; dependencies: AppDependencies; daemon: SessionProxyDaemon; remote: MachineClient; close(): Promise<void> }>` in app.originGuard.test.ts. Keep its concrete inferred spy type local; no production testing hooks.

- [ ] **Step 1: Create a gateway fixture and the complete unsafe/safe HTTP matrices.** This fixture uses exported existing fake services without modifying app.testSupport.ts. Define a file-local response factory rather than `piWebUiConfigResponse`, whose path getter requires the other file's hooks.

```ts
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "./app.js";
import { WebSocket } from "ws";
import { fakeRemoteClient, fakeSessionDaemon, createFakeSpeechInputSettingsService } from "./app.testSupport.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { MachineService } from "./machines/machineService.js";
import { MachineStore } from "./machines/machineStore.js";
import type { PiWebUiConfigValues, PiWebUiConfigResponse } from "../shared/apiTypes.js";
import type { PiWebUiConfigService } from "./configRoutes.js";
async function originGateway(allowedOrigins: string[] = [], socketTarget?: string) {
  const root = await mkdtemp(join(tmpdir(), "origin-gateway-"));
  const path = join(root, "workspace"); await mkdir(path);
  const projects = new ProjectService(new ProjectStore(join(root, "projects.json")));
  const project = await projects.add({ path }); const workspaces = new WorkspaceService();
  const workspace = (await workspaces.list(project))[0]; if (!workspace) throw new Error("Missing main workspace");
  const calls: string[] = []; const remoteCalls: string[] = [];
  let desired: PiWebUiConfigValues = { allowedOrigins };
  const response = (): PiWebUiConfigResponse => ({ path: join(root, "config.json"), exists: true, config: desired, effectiveConfig: desired, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
  const config: PiWebUiConfigService = { read: vi.fn(response), write: (next) => { desired = next; return response(); }, update: (change) => { desired = change(desired); return response(); } };
  const daemon = { ...fakeSessionDaemon(), request: async (method: string, path: string) => { calls.push(`${method} ${path}`); return { statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" }; }, connectWebSocket: (path: string) => { calls.push(`socket ${path}`); if (!socketTarget) throw new Error("Socket upstream was not configured"); return new WebSocket(socketTarget); } };
  const remote = fakeRemoteClient({ request: async (method, path) => { remoteCalls.push(`${method} ${path}`); return { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(["{}"]) }; }, connectWebSocket: (path) => { remoteCalls.push(`socket ${path}`); if (!socketTarget) throw new Error("Socket upstream was not configured"); return new WebSocket(socketTarget); } });
  const machines = new MachineService(new MachineStore(join(root, "machines.json")), { remoteClientFactory: () => remote });
  const machine = await machines.add({ name: "remote-a", baseUrl: "http://remote.invalid" });
  // The registry supplies a real public Machine; only its id is fixed for the matrix.
  const lookup = vi.spyOn(machines, "remoteTarget").mockImplementation(async () => ({ machine: { ...machine, id: "remote-a" }, client: remote }));
  const dependencies: AppDependencies = { projects, workspaces, machines, sessionDaemon: daemon, config, speechInputSettings: createFakeSpeechInputSettingsService(), clientDist: false, logger: false };
  const app = await buildApp(dependencies);
  return { app, root, project, workspace, calls, remoteCalls, lookup, config, dependencies, daemon, remote, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}
const prefixes = ["/api", "/api/machines/local", "/api/machines/remote-a"] as const;
const origins = { matching: "http://pi.test:8808", foreign: "https://foreign.example", null: "null", malformed: "%%%", absent: undefined } as const;
const methods = [
  { method: "POST", suffix: "/sessions", payload: { cwd: "/tmp" } },
  { method: "PUT", suffix: "/sessions/s1/model-policy", payload: { policy: { mode: "tiered", tier: "standard" } } },
  { method: "PATCH", suffix: "/skills", payload: { cwd: "/tmp", filePath: "/tmp/SKILL.md", disableModelInvocation: true } },
  { method: "DELETE", suffix: "/sessions/s1", payload: undefined },
] as const;
for (const prefix of prefixes) for (const entry of methods) for (const [name, origin] of Object.entries(origins)) {
  it(`gateway ${prefix} ${entry.method} ${name}`, async () => {
    const fixture = await originGateway();
    try {
      const before = fixture.lookup.mock.calls.length;
      const result = await fixture.app.inject({ method: entry.method, url: `${prefix}${entry.suffix}`, headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) }, ...(entry.payload === undefined ? {} : { payload: entry.payload }) });
      const accepted = name === "matching" || name === "absent";
      expect(result.statusCode).toBe(accepted ? 200 : 403);
      expect(fixture.calls.length + fixture.remoteCalls.length).toBe(accepted ? 1 : 0);
      if (!accepted) { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(fixture.lookup.mock.calls.length).toBe(before); }
    } finally { await fixture.close(); }
  });
}
for (const prefix of prefixes) for (const method of ["GET", "HEAD"] as const) it(`gateway safe ${prefix} ${method} ignores foreign Origin`, async () => {
  const fixture = await originGateway();
  try {
    const result = await fixture.app.inject({ method, url: `${prefix}/sessions?cwd=%2Ftmp`, headers: { host: "pi.test:8808", origin: "https://foreign.example" } });
    expect(result.statusCode).toBe(200); expect(fixture.calls.length + fixture.remoteCalls.length).toBe(1);
  } finally { await fixture.close(); }
});
```

Add this executable factory-edge control to sessionDaemonApp.originGuard.test.ts before its runtime expansion; imports are the production factory plus expect/it from Vitest:

```ts
it.each([
  ["http://pi.test:8808", 200], ["https://foreign.example", 403], ["null", 403], ["%%%", 403], [undefined, 200],
] as const)("constructs the production daemon HTTP edge for Origin %s", async (origin, expected) => {
  const app = await createSessionDaemonApp({ logger: false }); let calls = 0;
  app.post("/factory-control", () => { calls++; return { ok: true }; });
  try {
    const result = await app.inject({ method: "POST", url: "/factory-control", headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) } });
    expect(result.statusCode).toBe(expected); expect(calls).toBe(expected === 200 ? 1 : 0);
    if (expected === 403) expect(result.body).toBe('{"error":"Cross-origin request rejected"}');
  } finally { await app.close(); }
});
```

Valid gateway bodies are forwarded without interpreting daemon response shapes; daemon-specific payload validation belongs to its runtime matrix.

- [ ] **Step 2: Run `npm test -- --run src/server/app.originGuard.test.ts src/server/sessiond/sessionDaemonApp.originGuard.test.ts`.** Expect gateway denial rows to fail and factory import to be missing.
- [ ] **Step 3: Install both compositions without moving runtime ownership.** Immediately after `configService` is available in buildApp, insert:

```ts
const allowedOrigins = [...((await configService.read()).effectiveConfig.allowedOrigins ?? [])];
registerBrowserOriginGuard(app, allowedOrigins);
```

Create the factory exactly as follows:

```ts
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { sessionRouteFastifyOptions } from "../sessions/sessionRouteFastifyOptions.js";
import { registerBrowserOriginGuard } from "../http/browserOriginGuard.js";
export interface SessionDaemonAppOptions { allowedOrigins?: readonly string[]; logger?: FastifyServerOptions["logger"]; bodyLimit?: number }
export async function createSessionDaemonApp(options: SessionDaemonAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true, ...sessionRouteFastifyOptions, ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }) });
  registerBrowserOriginGuard(app, options.allowedOrigins);
  await app.register(fastifyWebsocket);
  return app;
}
```

In sessiond.ts remove Fastify, fastifyWebsocket, and sessionRouteFastifyOptions imports if now unused; import the factory and replace only edge construction with:

```ts
const app = await createSessionDaemonApp({ allowedOrigins: config.allowedOrigins ?? [], logger: true, bodyLimit: maxUploadBytes(daemonEnvironment, config) });
```

Do not import sessiond.ts from tests, change startup/listen/shutdown ordering, or add automatic restarts.

- [ ] **Step 4: Rerun the two focused test files and `npm run typecheck`.** The gateway matrix contains 60 unsafe rows and 6 safe rows; confirm every method/prefix/origin combination. Add this construction failure control in the gateway file:

```ts
it("stops gateway construction when startup config cannot be read", async () => {
  const f = await originGateway();
  try {
    await expect(buildApp({ ...f.dependencies, config: { ...f.config, read: async () => { throw new Error("config unavailable"); } } })).rejects.toThrow("config unavailable");
  } finally { await f.close(); }
});
```
- [ ] **Step 5: Commit.**

```bash
git add src/server/app.ts src/server/sessiond/sessionDaemonApp.ts src/server/sessiond.ts src/server/app.originGuard.test.ts src/server/sessiond/sessionDaemonApp.originGuard.test.ts
git commit -m "feat(security): install independent gateway and daemon startup guards"
```

## Task 7: Prove every gateway socket and startup activation boundary

**Implementer tier:** Advanced
**Lane:** origin-guard
**Dependencies:** Task 5, Task 6

**Files:**

- Modify: `src/server/app.originGuard.test.ts:1-400`

**Interfaces:**

- Consumes `registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins?: readonly string[]): void` from Task 5 through real `buildApp(deps?: AppDependencies): Promise<FastifyInstance>` from Task 6; never install a second test guard.
- Consumes Task 6's file-local `originGateway(allowedOrigins?: string[], socketTarget?: string)` result `{ app, root, project, workspace, calls: string[], remoteCalls: string[], lookup, config: PiWebUiConfigService, dependencies: AppDependencies, daemon: SessionProxyDaemon, remote: MachineClient, close(): Promise<void> }`; the socket override is configured before buildApp, never by replacing registered routes.
- Consumes `PiWebUiConfigService.update(mutate: (current: PiWebUiConfigValues) => PiWebUiConfigValues): PiWebUiConfigResponse | Promise<PiWebUiConfigResponse>` and `allowedOrigins?: string[]` from Tasks 2–3.
- Produces file-local `socketHandshake(url: string, origin?: string): Promise<{ status: number; body: string }>` with real ws unexpected-response observation and complete cleanup; no new production API.

- [ ] **Step 1: Add all 60 socket rows and independent activation/proxy cases.** Use a loopback WebSocketServer for functioning upstreams and the fixture's existing `socketTarget` argument. A successful handshake waits for the upstream's `ready` payload before terminating its socket, proving the bridge functioned.

```ts
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
async function socketHandshake(url: string, origin?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: origin === undefined ? {} : { origin } });
    const deadline = setTimeout(() => { socket.terminate(); reject(new Error("Handshake deadline")); }, 2000);
    const done = (status: number, body: string) => { clearTimeout(deadline); socket.terminate(); resolve({ status, body }); };
    socket.once("message", () => done(101, ""));
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = []; response.on("data", (c: Buffer) => chunks.push(c));
      response.once("end", () => done(response.statusCode ?? 0, Buffer.concat(chunks).toString()));
      response.once("error", reject);
    });
    socket.on("error", (error) => { clearTimeout(deadline); if (socket.readyState !== WebSocket.CLOSED) reject(error); });
  });
}
const families = ["/events", "/sessions/events", "/sessions/s1/events", "workspace terminal"] as const;
for (const prefix of prefixes) for (const family of families) for (const [name, fixedOrigin] of Object.entries(origins)) it(`gateway socket ${prefix} ${family} ${name}`, async () => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(upstream, "listening");
  let attached = 0; upstream.on("connection", (s) => { attached++; s.send("ready"); });
  const address = upstream.address(); if (typeof address === "string") throw new Error("TCP expected");
  const fixture = await originGateway([], `ws://127.0.0.1:${address.port}`);
  try {
    const http = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const origin = name === "matching" ? http : fixedOrigin;
    const suffix = family === "workspace terminal" ? `/projects/${encodeURIComponent(fixture.project.id)}/workspaces/${encodeURIComponent(fixture.workspace.id)}/terminals/t1/socket?cols=80&rows=24` : family;
    const before = fixture.lookup.mock.calls.length;
    const result = await socketHandshake(http.replace("http:", "ws:") + prefix + suffix, origin);
    const accepted = name === "matching" || name === "absent";
    expect(result.status).toBe(accepted ? 101 : 403);
    if (accepted) await vi.waitFor(() => expect(attached).toBe(1));
    else { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(attached).toBe(0); expect(fixture.calls).toEqual([]); expect(fixture.remoteCalls).toEqual([]); expect(fixture.lookup.mock.calls.length).toBe(before); }
  } finally {
    for (const socket of upstream.clients) socket.terminate();
    await fixture.close(); await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
it("gateway accepts the public HTTPS origin described by forwarded proto", async () => {
  const f = await originGateway();
  try {
    for (const [origin, expected] of [["https://pi.test:8808", 200], ["http://pi.test:8808", 403]] as const) expect((await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "pi.test:8808", "x-forwarded-proto": "https, http", origin } })).statusCode).toBe(expected);
  } finally { await f.close(); }
});
it("gateway permits only an exact configured public origin after Host rewriting", async () => {
  for (const allowedOrigins of [[], ["https://public.example:8443"]]) {
    const f = await originGateway(allowedOrigins);
    try {
      await f.config.update((c) => ({ ...c, allowedHosts: true }));
      for (const [origin, expected] of [["https://public.example:8443", allowedOrigins.length ? 200 : 403], ["https://public.example:8444", 403]] as const) expect((await f.app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "internal:8808", origin } })).statusCode).toBe(expected);
    } finally { await f.close(); }
  }
});
it("gateway protects every unsafe method without awaiting body parsing", async () => {
  const f = await originGateway();
  try {
    for (const entry of methods) {
      const result = await f.app.inject({ method: entry.method, url: `/api${entry.suffix}`, headers: { host: "pi.test:8808", origin: "https://foreign.example", "content-type": "application/json" }, payload: "{" });
      expect(result.statusCode).toBe(403); expect(result.body).toBe('{"error":"Cross-origin request rejected"}');
    }
    expect(f.calls).toEqual([]); expect(f.remoteCalls).toEqual([]);
  } finally { await f.close(); }
});
```

```ts
it("gateway retains its startup snapshot until rebuilt", async () => {
  const initial: string[] = []; const f = await originGateway(initial); const rebuilt: FastifyInstance[] = [];
  const request = (app: FastifyInstance, origin: string) => app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: f.workspace.path }, headers: { host: "pi.test:8808", origin } });
  try {
    const saved = await f.app.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedOrigins: ["https://public.example"] } }, headers: { host: "pi.test:8808", origin: "http://pi.test:8808" } });
    expect(saved.json<PiWebUiConfigResponse>().config.allowedOrigins).toEqual(["https://public.example"]);
    initial.push("https://public.example");
    expect((await request(f.app, "https://public.example")).statusCode).toBe(403);
    expect((await request(f.app, "http://pi.test:8808")).statusCode).toBe(200);
    const next = await buildApp(f.dependencies); rebuilt.push(next);
    expect((await request(next, "https://public.example")).statusCode).toBe(200);
    const cleared = await next.inject({ method: "PUT", url: "/api/config", payload: { config: { allowedOrigins: [] } }, headers: { host: "pi.test:8808", origin: "http://pi.test:8808" } });
    expect(cleared.json<PiWebUiConfigResponse>().effectiveConfig.allowedOrigins).toEqual([]);
    expect((await request(next, "https://public.example")).statusCode).toBe(200);
    const last = await buildApp(f.dependencies); rebuilt.push(last);
    expect((await request(last, "https://public.example")).statusCode).toBe(403);
    expect((await request(last, "http://pi.test:8808")).statusCode).toBe(200);
  } finally { for (const app of rebuilt.reverse()) await app.close(); await f.close(); }
});
```

- [ ] **Step 2: Run `npm test -- --run src/server/app.originGuard.test.ts`.** Existing guard behavior may already pass: prove the tests' sensitivity by temporarily removing only the buildApp registration in a disposable copy outside the repository; rejection rows must fail while accepted rows remain valid. Never damage the active guard to manufacture a red run.
- [ ] **Step 3: Complete fixture socket and rebuild ownership without changing production behavior.** Await successful upstream attachment before terminating accepted downstream sockets; observe `unexpected-response` body/status for denials, not only generic error events. Ensure local terminal rows use the real workspace-terminal proxy and remote rows use the machine proxy. Do not invent `/api/terminals/t1/socket`.
- [ ] **Step 4: Rerun the focused file and `npx eslint src/server/app.originGuard.test.ts`.** Require 60 unsafe HTTP rows, 6 safe rows, 60 socket rows, all activation cases, no leaked sockets/listeners, and no production changes in this task.
- [ ] **Step 5: Commit.**

```bash
git add src/server/app.originGuard.test.ts
git commit -m "test(security): cover gateway socket families and startup activation"
```

## Task 8: Prove daemon runtime matrices and the real absent-Origin two-hop path

**Implementer tier:** Advanced
**Lane:** origin-guard
**Dependencies:** Task 5, Task 6, Task 7

**Files:**

- Modify: `src/server/sessiond/sessionDaemonApp.originGuard.test.ts:1-160`

**Interfaces:**

- Consumes `SessionDaemonAppOptions = { allowedOrigins?: readonly string[]; logger?: FastifyServerOptions["logger"]; bodyLimit?: number }`, `createSessionDaemonApp(options?: SessionDaemonAppOptions): Promise<FastifyInstance>` from Task 6 and the hook semantics from Task 5, through the production factory only.
- Consumes existing `registerSessionRoutes(app: FastifyInstance, sessions: SessionRouteService, eventHub: SessionEventHub, prefix?: string): void`, `registerTerminalRoutes(app: FastifyInstance, terminals: TerminalRouteService, prefix?: string): void`, and `registerSkillsConfigRoutes(app: FastifyInstance, skills: SkillsConfigService, prefix?: string): void`.
- Consumes real `SessionEventHub.add(sessionId: string, socket: RealtimeSocket): void` and `addGlobal(socket: RealtimeSocket): void`, spying while preserving their implementation.
- Consumes real `SessionDaemonClient(options?: LoadOptions)` with `request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ statusCode: number; headers: Record<string, string>; body: string }>` and `connectWebSocket(path: string): WebSocket`; configure through task-local `env.PI_WEBUI_SESSIOND_URL`.
- Produces file-local daemon fixture and 20 HTTP / 20 socket matrix rows plus snapshot and two-hop evidence. No runtime interface changes.

- [ ] **Step 1: Build the real factory plus real runtime routes and explicit fake boundaries.** Add the following file-local fixture; the complete session object is checked against SessionRouteService and unused operations throw. The skills dependency is a real class instance with only its public toggle spied.

```ts
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { createSessionDaemonApp } from "./sessionDaemonApp.js";
import { registerSessionRoutes } from "../sessions/sessionRoutes.js";
import type { SessionRouteService } from "../sessions/sessionService.js";
import { registerTerminalRoutes, type TerminalRouteService } from "../terminals/terminalRoutes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { SkillsConfigService } from "../skills/skillsConfigService.js";
import { registerSkillsConfigRoutes } from "../skills/skillsConfigRoutes.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { buildApp } from "../app.js";
import { createFakeSpeechInputSettingsService } from "../app.testSupport.js";
import { ProjectService } from "../projects/projectService.js";
import { ProjectStore } from "../storage/projectStore.js";
import { WorkspaceService } from "../workspaces/workspaceService.js";
import { MachineService } from "../machines/machineService.js";
import { MachineStore } from "../machines/machineStore.js";
import type { PiWebUiConfigResponse } from "../../shared/apiTypes.js";
async function daemonFixture(allowedOrigins: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "daemon-origin-")); await mkdir(join(root, "workspace"));
  const app = await createSessionDaemonApp({ allowedOrigins, logger: false }); const calls: string[] = [];
  const seenOrigins: (string | undefined)[] = []; app.addHook("onRequest", async (r) => { seenOrigins.push(r.headers.origin); });
  const info = { id: "s1", cwd: join(root, "workspace"), path: join(root, "s1.jsonl"), created: "2026-11-04T00:00:00.000Z", modified: "2026-11-04T00:00:00.000Z", messageCount: 0, firstMessage: "" };
  const status = { sessionId: "s1", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  const unused = (): never => { throw new Error("Unexpected daemon test method"); };
  const sessions: SessionRouteService = {
    list: async () => [info], start: async () => { calls.push("start"); return info; },
    setModelPolicy: async () => { calls.push("setModelPolicy"); return { contractVersion: 1, policy: { mode: "tiered", tier: "standard", exact: { model: { provider: "openai", id: "test" }, thinkingLevel: "off" } }, session: status }; },
    deleteArchived: async () => { calls.push("deleteArchived"); }, streamSnapshot: async () => ({ seq: 0, partial: null }),
    exportHistory: unused, messages: unused, status: unused, modelPolicy: unused, rememberCurrentModelPolicy: unused,
    systemPrompt: unused, extensionEntries: unused, notificationCatalog: unused, unreadCatalog: unused, acknowledgeUnread: unused,
    notificationInbox: unused, dismissNotification: unused, dismissAllNotifications: unused, clearQueue: unused, dismissWarning: unused,
    availableModels: unused, setModel: unused, cycleModel: unused, availableThinkingLevels: unused, setThinkingLevel: unused,
    cycleThinkingLevel: unused, commands: unused, prompt: unused, saveAttachments: unused, cleanupPreview: unused,
    cleanup: unused, forceCleanup: unused, archiveMany: unused, deleteArchivedMany: unused, shell: unused, runCommand: unused,
    respondToCommand: unused, navigateTree: unused, editFromHere: unused, forkFromHere: unused, abort: unused, stop: unused,
    archive: unused, archiveTree: unused, restore: unused, reload: unused, detachParent: unused, pin: unused, unpin: unused, reorder: unused,
  };
  const terminalCalls: string[] = [];
  const terminals: TerminalRouteService = {
    list: () => [], create: unused, closeForCwd: unused, close: unused,
    attach: (_id, handlers) => { terminalCalls.push("attach"); handlers.output("replayed", true); return () => undefined; },
    write: () => { terminalCalls.push("write"); }, resize: () => { terminalCalls.push("resize"); },
    continue: unused, runCommand: unused, listCommandRuns: unused, getCommandRun: unused, cancelCommandRun: unused,
  };
  const hub = new SessionEventHub(); const add = vi.spyOn(hub, "add"); const addGlobal = vi.spyOn(hub, "addGlobal");
  const skills = new SkillsConfigService({ agentDir: root, loadSkills: async () => [], fetcher: async () => { throw new Error("Unexpected network"); }, runNpx: async () => { throw new Error("Unexpected process"); } });
  vi.spyOn(skills, "toggle").mockImplementation(async () => { calls.push("toggle"); return { success: true }; });
  registerSessionRoutes(app, sessions, hub); registerTerminalRoutes(app, terminals); registerSkillsConfigRoutes(app, skills);
  return { app, root, calls, seenOrigins, get subscriptionCount() { return add.mock.calls.length + addGlobal.mock.calls.length; }, get attachCount() { return terminalCalls.filter((v) => v === "attach").length; }, get resizeCount() { return terminalCalls.filter((v) => v === "resize").length; }, get writeCount() { return terminalCalls.filter((v) => v === "write").length; }, async close() { await app.close(); add.mockRestore(); addGlobal.mockRestore(); await rm(root, { recursive: true, force: true }); } };
}
function handshake(url: string, origin: string | undefined, waitForData = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: origin === undefined ? {} : { origin } }); let settled = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Daemon handshake deadline")); }, 2000);
    const finish = (status: number, body: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolve({ status, body }); };
    socket.once(waitForData ? "message" : "open", () => finish(101, ""));
    socket.once("unexpected-response", (_r, response) => { const chunks: Buffer[] = []; response.on("data", (c: Buffer) => chunks.push(c)); response.once("end", () => finish(response.statusCode ?? 0, Buffer.concat(chunks).toString())); response.once("error", reject); });
    socket.on("error", (error) => { if (!settled) { clearTimeout(timer); reject(error); } });
  });
}
```

Add matrices with these exact dimensions and names, using the file-local fixture. Their canonical specification 10.16 families are `daemon <method> <origin case> guards the actual runtime route` and `daemon socket <family> <origin case> rejects before runtime attachment`; substitute each method/family/origin row label:

```ts
const daemonHttpCases = [
  ["POST", "/sessions", { cwd: "/tmp" }, "start"],
  ["PUT", "/sessions/s1/model-policy", { policy: { mode: "tiered", tier: "standard" } }, "setModelPolicy"],
  ["PATCH", "/skills", { cwd: "/tmp", filePath: "/tmp/SKILL.md", disableModelInvocation: true }, "toggle"],
  ["DELETE", "/sessions/s1", undefined, "deleteArchived"],
] as const;
const daemonOrigins = { matching: "http://pi.test:8808", foreign: "https://foreign.example", null: "null", malformed: "%%%", absent: undefined } as const;
for (const [method, path, payload, boundary] of daemonHttpCases) for (const [name, origin] of Object.entries(daemonOrigins)) it(`daemon ${method} ${name} guards the actual runtime route`, async () => {
  const f = await daemonFixture();
  try {
    const response = await f.app.inject({ method, url: path, ...(payload === undefined ? {} : { payload }), headers: { host: "pi.test:8808", ...(origin === undefined ? {} : { origin }) } });
    const admitted = name === "matching" || name === "absent";
    expect(response.statusCode).toBe(admitted ? 200 : 403);
    expect(f.calls).toEqual(admitted ? [boundary] : []);
    if (!admitted) expect(response.body).toBe('{"error":"Cross-origin request rejected"}');
  } finally { await f.close(); }
});
for (const family of ["/events", "/sessions/events", "/sessions/s1/events", "/terminals/t1/socket?cols=80&rows=24"]) for (const [name, fixedOrigin] of Object.entries(daemonOrigins)) it(`daemon socket ${family} ${name} rejects before runtime attachment`, async () => {
  const f = await daemonFixture();
  try {
    const http = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const result = await handshake(http.replace("http:", "ws:") + family, name === "matching" ? http : fixedOrigin);
    const admitted = name === "matching" || name === "absent";
    expect(result.status).toBe(admitted ? 101 : 403);
    expect(f.subscriptionCount + f.attachCount).toBe(admitted ? 1 : 0);
    if (!admitted) { expect(result.body).toBe('{"error":"Cross-origin request rejected"}'); expect(f.resizeCount).toBe(0); expect(f.writeCount).toBe(0); }
  } finally { await f.close(); }
});
```

The fixture and handshake helper remain private to this file. All 40 runtime matrix rows use the production factory and route registrations.

- [ ] **Step 2: Run `npm test -- --run src/server/sessiond/sessionDaemonApp.originGuard.test.ts`.** Check valid payloads independently reach services before evaluating denial rows; a parser 400 is not an allowed control.
- [ ] **Step 3: Add executable snapshot and two-hop controls.**

```ts
it("daemon reads a copied startup snapshot and changes only after reconstruction", async () => {
  const list = ["https://first.example"]; const old = await daemonFixture(list); list[0] = "https://next.example"; const next = await daemonFixture(list);
  try {
    for (const [f, origin, expected] of [[old, "https://first.example", 200], [old, "https://next.example", 403], [next, "https://next.example", 200], [next, "https://first.example", 403], [old, "http://pi.test:8808", 200], [next, "http://pi.test:8808", 200]] as const) {
      const response = await f.app.inject({ method: "POST", url: "/sessions", payload: { cwd: join(f.root, "workspace") }, headers: { host: "pi.test:8808", origin } }); expect(response.statusCode).toBe(expected);
    }
  } finally { await old.close(); await next.close(); }
});
it("ordinary absent-Origin traffic works across the real gateway to daemon hop", async () => {
  const f = await daemonFixture(); let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const daemonHttp = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new SessionDaemonClient({ env: { PI_WEBUI_CONFIG: join(f.root, "unused-config.json"), PI_WEBUI_SESSIOND_URL: daemonHttp } });
    const projects = new ProjectService(new ProjectStore(join(f.root, "projects.json"))); await projects.add({ path: join(f.root, "workspace") });
    const response = (): PiWebUiConfigResponse => ({ path: join(f.root, "config.json"), exists: false, config: {}, effectiveConfig: {}, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
    gateway = await buildApp({ projects, workspaces: new WorkspaceService(), machines: new MachineService(new MachineStore(join(f.root, "machines.json"))), config: { read: response, write: response, update: response }, speechInputSettings: createFakeSpeechInputSettingsService(), sessionDaemon: client, logger: false, clientDist: false });
    const gatewayHttp = await gateway.listen({ host: "127.0.0.1", port: 0 });
    const post = await gateway.inject({ method: "POST", url: "/api/sessions", payload: { cwd: join(f.root, "workspace") }, headers: { host: "gateway.test", origin: "http://gateway.test" } });
    expect(post.statusCode).toBe(200); expect(f.calls).toEqual(["start"]);
    const socketResult = await handshake(gatewayHttp.replace("http:", "ws:") + "/api/sessions/s1/events", gatewayHttp, true); expect(socketResult.status).toBe(101);
    await vi.waitFor(() => expect(f.subscriptionCount).toBe(1)); expect(f.seenOrigins.every((value) => value === undefined)).toBe(true);
    const calls = [...f.calls]; const subscriptions = f.subscriptionCount;
    for (const origin of ["https://foreign.example", "null"]) {
      const direct = await f.app.inject({ method: "POST", url: "/sessions", payload: { cwd: "/tmp" }, headers: { host: "pi.test:8808", origin } }); expect(direct.statusCode).toBe(403);
      expect((await handshake(daemonHttp.replace("http:", "ws:") + "/sessions/s1/events", origin)).status).toBe(403);
    }
    expect(f.calls).toEqual(calls); expect(f.subscriptionCount).toBe(subscriptions);
  } finally { await gateway?.close(); await f.close(); }
});
```

No test starts Pi, ptys, migrations, live credentials, or executable sessiond.ts.
- [ ] **Step 4: Rerun the focused file and `npm run typecheck`.** In a disposable copy remove only the factory hook registration and confirm denial rows fail while admitted rows pass; record exact failing test names. This is the isolated sensitivity control when behavior was already implemented by Task 6.
- [ ] **Step 5: Commit.**

```bash
git add src/server/sessiond/sessionDaemonApp.originGuard.test.ts
git commit -m "test(security): prove daemon origin matrices and gateway compatibility"
```

## Task 9: Preserve configured machine Origin behavior on HTTP and sockets

**Implementer tier:** Standard
**Lane:** origin-guard
**Dependencies:** Task 5, Task 6, Task 8

**Files:**

- Modify: `src/server/machines/machineClient.test.ts:1-85`

**Interfaces:**

- Consumes `registerBrowserOriginGuard(app: FastifyInstance, allowedOrigins?: readonly string[]): void` from Task 5 and `createSessionDaemonApp(options?: SessionDaemonAppOptions): Promise<FastifyInstance>` from Task 6.
- Retains existing `new RemoteMachineClient(machine: Pick<StoredMachine, "baseUrl" | "token" | "headers" | "requestTimeoutMs">, fetchImpl?: typeof fetch)`, `request(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineHttpResponse>`, `requestJson(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineJsonResponse>`, and `connectWebSocket(path: string): WebSocket`.
- Produces only tests; configured Origin is already preserved by the production filter and must remain so. No machine client, machine schema, or request-forwarding production change is authorized here.

- [ ] **Step 1: Add the four named cases against real boundaries.** For default/configured headers use injected fetch and a real local WebSocketServer; the HTTP capture is:

```ts
it("sends no Origin by default for machine HTTP and WebSocket traffic", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => { expect(new Headers(init?.headers).has("origin")).toBe(false); return new Response("{}"); });
  const app = await createSessionDaemonApp({ logger: false }); const seen: (string | undefined)[] = [];
  app.get("/socket", { websocket: true }, (s, r) => { seen.push(r.headers.origin); s.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = new RemoteMachineClient({ baseUrl }, fetcher); await client.requestJson("POST", "/action", {});
    const socket = client.connectWebSocket("/socket"); await once(socket, "message"); socket.terminate();
    expect(seen).toEqual([undefined]);
  } finally { await app.close(); }
});
it("preserves a configured machine Origin for HTTP and WebSocket traffic", async () => {
  const configured = "https://public.example:8443";
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => { const h = new Headers(init?.headers); expect(h.get("origin")).toBe(configured); expect(h.has("cookie")).toBe(false); expect(h.get("authorization")).toBe("Bearer machine-token"); return new Response("{}"); });
  const app = await createSessionDaemonApp({ logger: false, allowedOrigins: [configured] }); const seen: (string | undefined)[] = [];
  app.get("/socket", { websocket: true }, (s, r) => { seen.push(r.headers.origin); expect(r.headers.cookie).toBeUndefined(); s.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const client = new RemoteMachineClient({ baseUrl, token: "machine-token", headers: { oRiGiN: configured, Cookie: "blocked", Authorization: "blocked" } }, fetcher);
    await client.requestJson("POST", "/action", {});
    const socket = client.connectWebSocket("/socket"); await once(socket, "message"); socket.terminate(); expect(seen).toEqual([configured]);
  } finally { await app.close(); }
});
```

Add the following two real-guard controls and file-local helper in machineClient.test.ts. Imports: `once` from node:events, WebSocket from ws, and `createSessionDaemonApp` from `../sessiond/sessionDaemonApp.js`. Wrap every admitted `once(socket, "message")` in a 2-second deadline with socket termination in finally; rejected handshakes use the helper's own deadline.

```ts
function observeMachineSocket(socket: WebSocket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let complete = false; const timer = setTimeout(() => { socket.terminate(); reject(new Error("Machine handshake deadline")); }, 2000);
    const finish = (status: number, body: string) => { if (complete) return; complete = true; clearTimeout(timer); socket.terminate(); resolve({ status, body }); };
    socket.once("message", () => finish(101, ""));
    socket.once("unexpected-response", (_request, response) => { const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk)); response.once("end", () => finish(response.statusCode ?? 0, Buffer.concat(chunks).toString())); });
    socket.on("error", (error) => { if (!complete) { clearTimeout(timer); reject(error); } });
  });
}
async function guardedMachine(allowedOrigins: string[]) {
  const app = await createSessionDaemonApp({ allowedOrigins, logger: false }); const calls = { action: 0, socket: 0 };
  app.post("/action", () => { calls.action++; return { ok: true }; });
  app.get("/socket", { websocket: true }, (socket) => { calls.socket++; socket.send("ready"); });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 }); return { app, baseUrl, calls };
}
it("configured matching Origin works against an empty remote allowlist", async () => {
  const f = await guardedMachine([]);
  try {
    const client = new RemoteMachineClient({ baseUrl: f.baseUrl, headers: { oRiGiN: f.baseUrl } });
    expect((await client.requestJson("POST", "/action", {})).statusCode).toBe(200);
    expect((await observeMachineSocket(client.connectWebSocket("/socket"))).status).toBe(101);
    expect(f.calls).toEqual({ action: 1, socket: 1 });
  } finally { await f.app.close(); }
});
it("configured foreign Origin requires the remote startup allowlist", async () => {
  const configured = "https://public.example:8443";
  for (const allowedOrigins of [[], [configured]]) {
    const f = await guardedMachine(allowedOrigins);
    try {
      for (const origin of [configured, "https://public.example:8444", "%%%", "null"]) {
        const expected = allowedOrigins.length && origin === configured ? 200 : 403; const before = { ...f.calls };
        const client = new RemoteMachineClient({ baseUrl: f.baseUrl, headers: { Origin: origin } });
        const response = await client.requestJson("POST", "/action", {}); expect(response.statusCode).toBe(expected);
        const socket = await observeMachineSocket(client.connectWebSocket("/socket")); expect(socket.status).toBe(expected === 200 ? 101 : 403);
        if (expected === 403) { expect(response.body).toEqual({ error: "Cross-origin request rejected" }); expect(socket.body).toBe('{"error":"Cross-origin request rejected"}'); expect(f.calls).toEqual(before); }
        else expect(f.calls).toEqual({ action: before.action + 1, socket: before.socket + 1 });
      }
    } finally { await f.app.close(); }
  }
});
```

Invalid startup entries must fail construction; configured machine Origin remains operator input, independent of the incoming browser Origin.

- [ ] **Step 2: Run `npm test -- --run src/server/machines/machineClient.test.ts`.** Existing behavior can already pass. Prove configured-header assertions fail in a disposable copy when only Origin is added to BLOCKED_CONFIGURED_HEADER_NAMES; restore that copy and rerun green.
- [ ] **Step 3: Complete counting/handshake fixture cleanup and keep production untouched.** A configured machine Origin is operator input, independent of the original browser Origin; do not add browser header forwarding.
- [ ] **Step 4: Rerun the focused file and `npx eslint src/server/machines/machineClient.test.ts`.** Record admitted and rejected HTTP/socket counters.
- [ ] **Step 5: Commit.**

```bash
git add src/server/machines/machineClient.test.ts
git commit -m "test(federation): preserve configured machine origin semantics"
```

## Task 10: Distinguish target absence from root failures without changing Explorer messages

**Implementer tier:** Standard
**Lane:** file-service
**Dependencies:** Task 2

**Files:**

- Modify: `src/server/workspaces/pathAccessPolicy.ts:1-7`, `src/server/workspaces/pathAccessPolicy.ts:51-112`
- Test: `src/server/workspaces/pathAccessPolicy.test.ts`

**Interfaces:**

- Consumes existing `resolveWorkspacePathAccessTarget(rootPath: string, requestedPath: string | undefined, pathAccess?: PiWebUiPathAccessConfig, options?: PathAccessPolicyOptions): Promise<ResolvedPathAccessTarget>`, where `ResolvedPathAccessTarget = { kind: "workspace" | "allowed"; root: string; target: string; displayPath: string }`.
- Produces exported `PathAccessTargetNotFoundError extends Error` and `PathAccessRootError extends Error`, each with `constructor(message: string, options?: ErrorOptions)`; both retain existing Error.message and preserve cause.
- Retains every existing containment/allowed-root rule and Explorer response mapping. No new path permission or public resolver signature.

- [ ] **Step 1: Add typed-error tests in the existing temporary-root fixture.** Import both new classes, node fs stat/chmod, and real `readWorkspaceFile` for message comparison. Capture actual Node ENOTDIR independently with `realpath` before invoking the policy.

```ts
it("wrap target ENOENT and ENOTDIR as PathAccessTargetNotFoundError", async () => {
  const workspace = await tempRoot(); const allowed = await tempRoot();
  for (const root of [workspace, allowed]) await writeFile(join(root, "ordinary.txt"), "file");
  for (const root of [workspace, allowed]) for (const request of ["missing.html", "ordinary.txt/child.html"]) {
    const absolute = join(root, request); let nodeMessage: string | undefined;
    try { await realpath(absolute); } catch (e) { if (e instanceof Error) nodeMessage = e.message; }
    const error = await resolveWorkspacePathAccessTarget(workspace, root === workspace ? request : absolute, { allowedPaths: [allowed] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PathAccessTargetNotFoundError);
    expect(error).not.toBeInstanceOf(PathAccessRootError);
    expect(error).toHaveProperty("message", request === "missing.html" ? "Path does not exist" : nodeMessage);
  }
});
it("wrap root canonicalization failures as PathAccessRootError", async () => {
  const workspace = await tempRoot(); const root = await tempRoot(); const ordinary = join(root, "ordinary.txt"); await writeFile(ordinary, "file");
  for (const bad of [join(root, "missing"), ordinary]) {
    for (const operation of [() => resolveWorkspacePathAccessTarget(bad, "a.html"), () => resolveWorkspacePathAccessTarget(workspace, join(bad, "a.html"), { allowedPaths: [bad] })]) {
      const error = await operation().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PathAccessRootError); expect(error).not.toBeInstanceOf(PathAccessTargetNotFoundError);
      expect(error).toHaveProperty("message", expect.stringMatching(/does not exist|must be a directory/u));
    }
  }
});
it("wrap root failures as PathAccessRootError, never as the target type", async (context) => {
  if (process.platform === "win32") { context.skip(); return; }
  const workspace = await tempRoot(); const root = await tempRoot(); const cycle = join(root, "cycle"); await symlink(cycle, cycle);
  const blocked = join(root, "blocked"); await mkdir(blocked); await mkdir(join(blocked, "child")); await chmod(blocked, 0);
  try {
    for (const bad of [cycle, join(blocked, "child")]) {
      // Permission assertions require an unprivileged process; never count a root-user pass as denial evidence.
      if (bad !== cycle && process.getuid?.() === 0) continue;
      for (const operation of [() => resolveWorkspacePathAccessTarget(bad, "a.html"), () => resolveWorkspacePathAccessTarget(workspace, join(bad, "a.html"), { allowedPaths: [bad] })]) {
        const error = await operation().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(PathAccessRootError); expect(error).not.toBeInstanceOf(PathAccessTargetNotFoundError);
      }
    }
    if (process.getuid?.() !== 0) {
      const error = await resolveWorkspacePathAccessTarget(blocked, "child/a.html").catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(PathAccessRootError); expect(error).toHaveProperty("code", "EACCES");
    }
  } finally { await chmod(blocked, 0o700); }
});
it("keep existing Explorer error messages unchanged", async () => {
  const root = await tempRoot(); await writeFile(join(root, "ordinary.txt"), "file");
  for (const path of ["missing.html", "ordinary.txt/child.html"]) {
    let original = "Path does not exist";
    if (path.includes("/")) { try { await realpath(join(root, path)); } catch (e) { if (e instanceof Error) original = e.message; } }
    const error = await readWorkspaceFile(root, path).catch((e: unknown) => e);
    expect(error).toHaveProperty("message", original);
    expect(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })).toBe(JSON.stringify({ error: original }));
  }
});
```

Run the existing `/file` Explorer route in a small real Fastify registration as an additional control: its body remains `JSON.stringify({ error: original })` and status 400 for both missing and ENOTDIR. Record pre-change bytes before modifying the module, then compare after. Root permission fixtures must preserve existing raw Node messages; report unavailable native controls explicitly on unsupported/privileged hosts and retain injected coverage in the service task.

- [ ] **Step 2: Run `npm test -- --run src/server/workspaces/pathAccessPolicy.test.ts`.** Record baseline Explorer error bodies separately; new type assertions fail before implementation.
- [ ] **Step 3: Add only typed operation-stage wrappers.**

```ts
export class PathAccessTargetNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "PathAccessTargetNotFoundError"; }
}
export class PathAccessRootError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "PathAccessRootError"; }
}
// Replace canonicalDirectory, preserving its internal messages:
async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await canonicalExistingPath(path, `${label} does not exist`);
    const result = await stat(canonical);
    if (!result.isDirectory()) throw new Error(`${label} must be a directory`);
    return canonical;
  } catch (error) {
    throw new PathAccessRootError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
async function canonicalExistingPath(path: string, missingMessage = "Path does not exist", targetStage = false): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (targetStage && (isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTDIR"))) {
      throw new PathAccessTargetNotFoundError(isNodeErrorWithCode(error, "ENOENT") ? missingMessage : error.message, { cause: error });
    }
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error(missingMessage, { cause: error });
    throw error;
  }
}
```

Change only the two target calls to `canonicalExistingPath(resolve(policy.workspaceRoot, displayPath), "Path does not exist", true)` and `canonicalExistingPath(displayPath, "Path does not exist", true)`. Root calls keep the default false. No cause-chain inspection in callers and no message changes.

- [ ] **Step 4: Rerun the focused file plus `npm run typecheck`.** Existing path-policy cases and byte comparison must pass.
- [ ] **Step 5: Commit.**

```bash
git add src/server/workspaces/pathAccessPolicy.ts src/server/workspaces/pathAccessPolicy.test.ts
git commit -m "refactor(files): type target and root resolution failures"
```

## Task 11: Build the authorized handle-backed file-view service

**Implementer tier:** Advanced
**Lane:** file-service
**Dependencies:** Task 1, Task 10

**Files:**

- Create: `src/server/workspaces/fileViewService.ts`
- Test: `src/server/workspaces/fileViewService.test.ts`

**Interfaces:**

- Consumes `FileViewKind = "document" | "pdf" | "image" | "text"`, `fileViewKindForPath(path: string): FileViewKind | undefined`, `MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024`, `MAX_FILE_VIEW_LABEL = "64 MB"` from Task 1.
- Consumes `resolveWorkspacePathAccessTarget(rootPath: string, requestedPath: string | undefined, pathAccess?: PiWebUiPathAccessConfig, options?: PathAccessPolicyOptions): Promise<{ kind: "workspace" | "allowed"; root: string; target: string; displayPath: string }>` and `PathAccessTargetNotFoundError` / `PathAccessRootError` from Task 10.
- Consumes existing `imageMimeTypeForPath(path: string): string | undefined`.
- Produces `FileViewError extends Error` with `readonly status: 400 | 403 | 404 | 413 | 415` and `constructor(status: 400 | 403 | 404 | 413 | 415, message: string, options?: ErrorOptions)`.
- Produces `WorkspaceFileView = { path: string; kind: FileViewKind; mediaType: string; size: number; modifiedAt: string; stream: ReadStream }`.
- Produces `WorkspaceFileViewOpener = (rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig) => Promise<WorkspaceFileView>`.
- Produces `FileViewStat = Pick<Stats, "dev" | "ino" | "size" | "mtime" | "isFile">`, `FileViewLstat = FileViewStat & Pick<Stats, "isSymbolicLink">`, `FileViewHandle = { readonly fd: number; stat(): Promise<FileViewStat>; createReadStream(options: { start: number; end: number; autoClose: true }): ReadStream; close(): Promise<void> }`.
- Produces `FileViewDependencies = { platform: NodeJS.Platform; authorize: typeof resolveWorkspacePathAccessTarget; open(path: string, flags: number): Promise<FileViewHandle>; lstat(path: string): Promise<FileViewLstat>; realpath(path: string): Promise<string> }`, `createWorkspaceFileViewOpener(overrides?: Partial<FileViewDependencies>): WorkspaceFileViewOpener`, and `openWorkspaceFileView(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<WorkspaceFileView>`.

- [ ] **Step 1: Add real-file fixtures and ordered validation tests.** The supported-kind table owns specification 10.6's `opens <supported kind fixture> with exact metadata and bytes`, with one independently labeled fixture per kind/extension. Define local `beforeEach`/`afterEach` that create a canonical temporary directory containing separate `root`, `allowed`, and `root2` directories. Write HTML/HTM/SVG/PDF/PNG/text bytes, unknown extension, supported-looking directory, and zero-byte HTML; use `fs.open(...,"w")` plus truncate for the sparse cap+1 fixture. Close fixture handles immediately. The following local helpers and test tables carry independent expectations:

```ts
import { constants, type ReadStream } from "node:fs";
import { mkdtemp, mkdir, open, realpath, rm, stat, writeFile, symlink, appendFile, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createWorkspaceFileViewOpener, openWorkspaceFileView, FileViewError } from "./fileViewService.js";
import { resolveWorkspacePathAccessTarget, PathAccessRootError } from "./pathAccessPolicy.js";
let fixture: string; let root: string; let allowed: string; let outside: string;
const supported = [
  ["a.html", "document", "text/html; charset=utf-8", Buffer.from("<p>hello</p>")],
  ["a.htm", "document", "text/html; charset=utf-8", Buffer.from("<p>short</p>")],
  ["a.svg", "document", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["a.pdf", "pdf", "application/pdf", Buffer.from("%PDF-1.7\n")],
  ["a.png", "image", "image/png", Buffer.from([137, 80, 78, 71])],
  ["a.txt", "text", "text/plain; charset=utf-8", Buffer.from("café\n")],
] as const;
beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "file-view-"))); root = join(fixture, "root"); allowed = join(fixture, "allowed"); outside = join(fixture, "root2");
  await Promise.all([root, allowed, outside].map((p) => mkdir(p)));
  for (const [name, , , bytes] of supported) await writeFile(join(root, name), bytes);
  await writeFile(join(root, "zero.html"), ""); await writeFile(join(root, "a.exe"), "unknown"); await mkdir(join(root, "directory.html"));
  await writeFile(join(allowed, "a.html"), "allowed"); await writeFile(join(outside, "a.html"), "outside");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(fixture, { recursive: true, force: true }); });
async function bytes(stream: ReadStream): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function assertClosed(stream: ReadStream): Promise<void> { if (!stream.closed) await once(stream, "close"); expect(stream.closed).toBe(true); }
const denied = "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.";
const unsupported = "This file type cannot be previewed in PI WEBUI.";
for (const [path, kind, mediaType, body] of supported) it(`opens ${path} with exact metadata and bytes`, async () => {
  const expectedStat = await stat(join(root, path)); const view = await openWorkspaceFileView(root, path);
  expect({ path: view.path, kind: view.kind, mediaType: view.mediaType, size: view.size, modifiedAt: view.modifiedAt }).toEqual({ path, kind, mediaType, size: body.length, modifiedAt: expectedStat.mtime.toISOString() });
  expect(await bytes(view.stream)).toEqual(body); await assertClosed(view.stream);
});
it("rejects absent and empty paths before authorization", async () => {
  const authorize = vi.fn<typeof resolveWorkspacePathAccessTarget>(); const openFile = vi.fn<typeof open>();
  const opener = createWorkspaceFileViewOpener({ authorize, open: openFile });
  for (const path of [undefined, ""]) await expect(opener(root, path)).rejects.toMatchObject({ status: 400, message: "path query parameter is required" });
  expect(authorize).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled();
});
it("rejects NUL paths before authorization", async () => {
  const authorize = vi.fn<typeof resolveWorkspacePathAccessTarget>();
  await expect(createWorkspaceFileViewOpener({ authorize })(root, "a\0.html")).rejects.toMatchObject({ status: 400, message: "path query parameter must not contain NUL bytes" }); expect(authorize).not.toHaveBeenCalled();
});
it("denies traversal, unconfigured absolute paths and symlink escapes", async (context) => {
  for (const path of ["../root2/a.html", join(root, "a.html")]) await expect(openWorkspaceFileView(root, path)).rejects.toMatchObject({ status: 403, message: denied });
  if (process.platform === "win32") { context.skip(); return; }
  await symlink(join(outside, "a.html"), join(root, "escape.html"));
  await expect(openWorkspaceFileView(root, "escape.html")).rejects.toMatchObject({ status: 403, message: denied });
  await symlink(join(root, "a.html"), join(root, "inside.html"));
  const inside = await openWorkspaceFileView(root, "inside.html"); expect(await bytes(inside.stream)).toEqual(Buffer.from("<p>hello</p>")); await assertClosed(inside.stream);
});
it("reads an absolute path only through a configured allowed root", async () => {
  const view = await openWorkspaceFileView(root, join(allowed, "a.html"), { allowedPaths: [allowed] });
  expect(view.path).toBe(join(allowed, "a.html")); expect(await bytes(view.stream)).toEqual(Buffer.from("allowed"));
  await expect(openWorkspaceFileView(root, join(outside, "a.html"), { allowedPaths: [root] })).rejects.toMatchObject({ status: 403, message: denied });
});
it("maps a missing target to 404 while retaining the request path", async () => {
  await expect(openWorkspaceFileView(root, "missing.html")).rejects.toMatchObject({ status: 404, message: "File not found: missing.html" });
});
it("maps a target below a regular-file ancestor to 404", async () => {
  await expect(openWorkspaceFileView(root, "a.txt/child.html")).rejects.toMatchObject({ status: 404, message: "File not found: a.txt/child.html" });
  await expect(openWorkspaceFileView(join(fixture, "missing-root"), "a.html")).rejects.toBeInstanceOf(PathAccessRootError);
});
it("rejects directories and unknown extensions with 415", async () => {
  for (const path of ["directory.html", "a.exe"]) await expect(openWorkspaceFileView(root, path)).rejects.toMatchObject({ status: 415, message: unsupported });
});
it("rejects oversized files after handle measurement and accepts the exact cap", async () => {
  const file = await open(join(root, "huge.html"), "w"); await file.truncate(67_108_865); await file.close();
  await expect(openWorkspaceFileView(root, "huge.html")).rejects.toMatchObject({ status: 413, message: "File is too large to preview (limit 64 MB)." });
  const handle = await open(join(root, "a.html"), "r"); const measured = await handle.stat();
  const streamFactory = vi.fn((options: { start: number; end: number; autoClose: true }) => handle.createReadStream(options));
  const opener = createWorkspaceFileViewOpener({ open: async () => ({ fd: handle.fd, stat: async () => ({ ...measured, isFile: () => true, size: 67_108_864 }), createReadStream: streamFactory, close: () => handle.close() }) });
  const exact = await opener(root, "a.html"); expect(exact.size).toBe(67_108_864); expect(streamFactory).toHaveBeenCalledWith({ start: 0, end: 67_108_863, autoClose: true }); exact.stream.destroy(); await assertClosed(exact.stream);
});
it("bounds a file grown after fstat at its measured size", async () => {
  const view = await openWorkspaceFileView(root, "a.txt"); await appendFile(join(root, "a.txt"), "new tail");
  expect(await bytes(view.stream)).toEqual(Buffer.from("café\n")); await assertClosed(view.stream);
});
it("returns a zero-byte stream without reading a file that grows after fstat", async () => {
  const view = await openWorkspaceFileView(root, "zero.html"); const read = vi.spyOn(view.stream, "_read");
  await appendFile(join(root, "zero.html"), "late bytes"); expect(await bytes(view.stream)).toEqual(Buffer.alloc(0)); expect(read).not.toHaveBeenCalled(); await assertClosed(view.stream);
});
```

- [ ] **Step 2: Run `npm test -- --run src/server/workspaces/fileViewService.test.ts`.** New service import fails first; after contracts exist, ordering/metadata/byte assertions must be meaningful failures.
- [ ] **Step 3: Implement the public interfaces and ordered service below.** Declare the exact interfaces from this task's Interfaces block with `ReadStream`/`Stats` imported from node:fs and the shared types from their modules; do not widen the dependency seam to a complete fake service.

```ts
import { constants, type ReadStream, type Stats } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { once } from "node:events";
import type { PiWebUiPathAccessConfig } from "../../shared/apiTypes.js";
import { fileViewKindForPath, MAX_FILE_VIEW_BYTES, type FileViewKind } from "../../shared/fileViewTypes.js";
import { imageMimeTypeForPath } from "./imagePreviewService.js";
import { PathAccessRootError, PathAccessTargetNotFoundError, resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";
export class FileViewError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 413 | 415, message: string, options?: ErrorOptions) { super(message, options); this.name = "FileViewError"; }
}
const DENIED = "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access.";
const UNSUPPORTED = "This file type cannot be previewed in PI WEBUI.";
function errno(error: unknown): string | undefined { return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function forbidden(error?: unknown): FileViewError { return new FileViewError(403, DENIED, error === undefined ? undefined : { cause: error }); }
function unsupported(error?: unknown): FileViewError { return new FileViewError(415, UNSUPPORTED, error === undefined ? undefined : { cause: error }); }
function mapOpenError(error: unknown, path: string): never {
  const code = errno(error);
  if (code === "ENOENT" || code === "ENOTDIR") throw new FileViewError(404, `File not found: ${path}`, { cause: error });
  if (code === "ENXIO" || code === "EOPNOTSUPP") throw unsupported(error);
  if (code === "ELOOP" || code === "EACCES" || code === "EPERM") throw forbidden(error);
  throw error;
}
function mapAuthorizationError(error: unknown, path: string): never {
  if (error instanceof PathAccessRootError) throw error;
  if (error instanceof PathAccessTargetNotFoundError) throw new FileViewError(404, `File not found: ${path}`, { cause: error });
  const message = error instanceof Error ? error.message : "";
  if (["Absolute paths are not allowed", "Path traversal is not allowed", "Path escapes workspace", "Path is outside allowed paths"].includes(message) || message.startsWith("Absolute path is not valid on this host:") || message.startsWith("Path is not absolute:") || ["EACCES", "EPERM", "ELOOP"].includes(errno(error) ?? "")) throw forbidden(error);
  throw error;
}
function identityMatches(before: FileViewLstat, after: FileViewStat): boolean {
  const devs = [before.dev, after.dev]; const inos = [before.ino, after.ino];
  return devs.every((v) => Number.isSafeInteger(v) && v >= 0) && inos.every((v) => Number.isSafeInteger(v) && v > 0) && before.dev === after.dev && before.ino === after.ino;
}
function mediaType(path: string, kind: FileViewKind): string {
  if (kind === "document") return /\.svg$/iu.test(path) ? "image/svg+xml" : "text/html; charset=utf-8";
  if (kind === "pdf") return "application/pdf";
  if (kind === "text") return "text/plain; charset=utf-8";
  const mime = imageMimeTypeForPath(path); if (mime === undefined) throw unsupported(); return mime;
}
export function createWorkspaceFileViewOpener(overrides: Partial<FileViewDependencies> = {}): WorkspaceFileViewOpener {
  const deps: FileViewDependencies = { platform: process.platform, authorize: resolveWorkspacePathAccessTarget, open, lstat, realpath, ...overrides };
  return async (rootPath, path, pathAccess) => {
    if (path === undefined || path === "") throw new FileViewError(400, "path query parameter is required");
    if (path.includes("\0")) throw new FileViewError(400, "path query parameter must not contain NUL bytes");
    const target = await deps.authorize(rootPath, path, pathAccess).catch((error: unknown) => mapAuthorizationError(error, path));
    let before: FileViewLstat | undefined;
    if (deps.platform === "win32") {
      before = await deps.lstat(target.target).catch((error: unknown) => mapOpenError(error, path));
      if (before.isSymbolicLink()) throw forbidden();
      if (!before.isFile()) throw unsupported();
    }
    const flags = deps.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await deps.open(target.target, flags).catch((error: unknown) => mapOpenError(error, path));
    let transferred = false; let constructed: ReadStream | undefined; let primary: unknown;
    try {
      const measured = await handle.stat();
      if (!measured.isFile()) throw unsupported();
      if (!Number.isSafeInteger(measured.size) || measured.size < 0) throw forbidden();
      if (measured.size > MAX_FILE_VIEW_BYTES) throw new FileViewError(413, "File is too large to preview (limit 64 MB).");
      if (before !== undefined && !identityMatches(before, measured)) throw forbidden();
      if (deps.platform === "linux") {
        let openedPath: string;
        try { openedPath = await deps.realpath(`/proc/self/fd/${handle.fd}`); } catch (error) { throw forbidden(error); }
        const rel = relative(target.root, openedPath);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw forbidden();
      }
      const kind = fileViewKindForPath(target.displayPath); if (kind === undefined) throw unsupported();
      const type = mediaType(target.displayPath, kind); const modifiedAt = measured.mtime.toISOString();
      constructed = handle.createReadStream({ start: 0, end: measured.size === 0 ? 0 : Math.min(measured.size, MAX_FILE_VIEW_BYTES) - 1, autoClose: true });
      if (measured.size === 0) constructed.push(null);
      const view: WorkspaceFileView = { path: target.displayPath, kind, mediaType: type, size: measured.size, modifiedAt, stream: constructed };
      transferred = true; return view;
    } catch (error) { primary = error; throw error; }
    finally {
      if (!transferred) {
        try {
          if (constructed === undefined) await handle.close();
          else { const closed = constructed.closed ? Promise.resolve() : once(constructed, "close").then(() => undefined); constructed.destroy(); await closed; }
        } catch (cleanup) {
          if (primary instanceof Error) Object.defineProperty(primary, "cause", { configurable: true, value: new AggregateError([primary.cause, cleanup].filter((v) => v !== undefined), "File-view cleanup failed") });
          else throw cleanup;
        }
      }
    }
  };
}
const defaultOpener = createWorkspaceFileViewOpener();
export async function openWorkspaceFileView(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<WorkspaceFileView> { return defaultOpener(rootPath, path, pathAccess); }
```

Keep stream-construction setup in the handle ownership region and do not suppress a close failure as a success. Observe a constructed stream's error while awaiting close, so cleanup cannot create an unhandled event. Map no unknown errno to 415; metadata failures stay ordinary infrastructure errors.

- [ ] **Step 4: Rerun the focused file and `npm run typecheck`.** Inspect that createReadStream is called on the authorized handle, fstat owns size/mtime, no second path stream exists, and no reads occur in the zero-size case.
- [ ] **Step 5: Commit.**

```bash
git add src/server/workspaces/fileViewService.ts src/server/workspaces/fileViewService.test.ts
git commit -m "feat(files): open authorized previews from one bounded file handle"
```

## Task 12: Pin platform races, errno stages, and every pre-transfer cleanup path

**Implementer tier:** Advanced
**Lane:** file-service
**Dependencies:** Task 10, Task 11

**Files:**

- Modify: `src/server/workspaces/fileViewService.test.ts:1-400`
- Modify: `src/server/workspaces/fileViewService.ts:1-220` only if a newly added mechanism test exposes a contract violation

**Interfaces:**

- Consumes `createWorkspaceFileViewOpener(overrides?: Partial<FileViewDependencies>): WorkspaceFileViewOpener` and `openWorkspaceFileView(rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig): Promise<WorkspaceFileView>` from Task 11.
- Consumes `FileViewDependencies = { platform: NodeJS.Platform; authorize: typeof resolveWorkspacePathAccessTarget; open(path: string, flags: number): Promise<FileViewHandle>; lstat(path: string): Promise<FileViewLstat>; realpath(path: string): Promise<string> }`.
- Consumes `FileViewHandle = { readonly fd: number; stat(): Promise<FileViewStat>; createReadStream(options: { start: number; end: number; autoClose: true }): ReadStream; close(): Promise<void> }`, `FileViewStat = Pick<Stats, "dev" | "ino" | "size" | "mtime" | "isFile">`, and `FileViewLstat = FileViewStat & Pick<Stats, "isSymbolicLink">` from Task 11.
- Consumes Task 10 typed path errors and Task 11 file-local `root`, `allowed`, `outside`, `bytes(stream: ReadStream): Promise<Buffer>`, `assertClosed(stream: ReadStream): Promise<void>` fixtures. Produces complete platform/race evidence with no new public API.

- [ ] **Step 1: Add deterministic injected and native platform cases.** Add `type FileViewDependencies` and `type FileViewLstat` to this file's existing service imports. The canonical specification 10.6 table families here are `uses no-follow and nonblocking flags on <POSIX platform>` and `denies <Windows identity failure>`; each row substitutes the platform or failure label. Use real handles behind the seam and explicit await barriers, with these core test bodies:

```ts
it.each(["linux", "darwin"] as const)("uses no-follow and nonblocking flags on %s", async (platform) => {
  const openFile = vi.fn(async (path: string, flags: number) => { expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW); expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK); expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0); return open(path, flags); });
  const view = await createWorkspaceFileViewOpener({ platform, open: openFile })(root, "a.html"); await bytes(view.stream); await assertClosed(view.stream); expect(openFile).toHaveBeenCalledOnce();
});
it("rejects a final-component symlink swapped after authorization", async (context) => {
  if (process.platform === "win32") { context.skip(); return; }
  const authorize = async (...args: Parameters<typeof resolveWorkspacePathAccessTarget>) => {
    const target = await resolveWorkspacePathAccessTarget(...args);
    await rename(target.target, join(root, "original.html")); await symlink(join(root, "a.htm"), target.target); return target;
  };
  await expect(createWorkspaceFileViewOpener({ authorize })(root, "a.html")).rejects.toMatchObject({ status: 403, message: denied });
});
it("rejects an opened Linux handle outside its granting root", async () => {
  const handle = await open(join(outside, "a.html"), "r"); const close = vi.spyOn(handle, "close");
  await expect(createWorkspaceFileViewOpener({ platform: "linux", open: async () => handle })(root, "a.html")).rejects.toMatchObject({ status: 403, message: denied }); expect(close).toHaveBeenCalledOnce();
});
it("rejects a Linux opened-handle near-prefix sibling", async () => {
  const handle = await open(join(outside, "a.html"), "r"); const close = vi.spyOn(handle, "close");
  const view = createWorkspaceFileViewOpener({ platform: "linux", open: async () => handle, realpath: async () => join(outside, "a.html") });
  await expect(view(root, "a.html")).rejects.toMatchObject({ status: 403 }); expect(close).toHaveBeenCalledOnce();
});
it("fails closed when Linux fd containment lookup fails", async () => {
  const handle = await open(join(root, "a.html"), "r"); const close = vi.spyOn(handle, "close");
  await expect(createWorkspaceFileViewOpener({ platform: "linux", open: async () => handle, realpath: async () => { throw new Error("proc unavailable"); } })(root, "a.html")).rejects.toMatchObject({ status: 403 }); expect(close).toHaveBeenCalledOnce();
});
it("does not perform Linux fd lookup on another POSIX host", async () => {
  const lookup = vi.fn(async () => { throw new Error("Linux-only lookup"); });
  const view = await createWorkspaceFileViewOpener({ platform: "darwin", realpath: lookup })(root, "a.html"); expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>")); expect(lookup).not.toHaveBeenCalled();
});
it("streams the pinned handle when the pathname is replaced after open", async () => {
  const handle = await open(join(root, "a.html"), "r"); let created: ReadStream | undefined;
  const opener = createWorkspaceFileViewOpener({ open: async () => ({ fd: handle.fd, stat: () => handle.stat(), close: () => handle.close(), createReadStream: (options) => { created = handle.createReadStream(options); return created; } }) });
  const view = await opener(root, "a.html"); expect(view.stream).toBe(created);
  await rename(join(root, "a.html"), join(root, "old.html")); await writeFile(join(root, "a.html"), "replacement");
  expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>")); await assertClosed(view.stream);
});
it("uses conclusive Windows identity and fstat size", async () => {
  const handle = await open(join(root, "a.html"), "r"); const real = await handle.stat();
  const lookup = vi.fn(async () => { throw new Error("proc on Windows"); });
  const openFile = vi.fn(async (_path: string, flags: number) => { expect(flags).toBe(constants.O_RDONLY); return { fd: handle.fd, stat: async () => ({ ...real, isFile: () => true, dev: 1, ino: 7 }), createReadStream: (o: { start: number; end: number; autoClose: true }) => handle.createReadStream(o), close: () => handle.close() }; });
  const view = await createWorkspaceFileViewOpener({ platform: "win32", open: openFile, realpath: lookup, lstat: async () => ({ ...real, dev: 1, ino: 7, size: 999_999_999, isFile: () => true, isSymbolicLink: () => false }) })(root, "a.html");
  expect(view.size).toBe(12); expect(await bytes(view.stream)).toEqual(Buffer.from("<p>hello</p>")); expect(lookup).not.toHaveBeenCalled();
});
const identityFailures = [
  ["lstat symlink", { dev: 1, ino: 7, symlink: true }, { dev: 1, ino: 7 }, false],
  ["dev mismatch", { dev: 1, ino: 7 }, { dev: 2, ino: 7 }, true],
  ["ino mismatch", { dev: 1, ino: 7 }, { dev: 1, ino: 8 }, true],
  ["zero inode", { dev: 1, ino: 0 }, { dev: 1, ino: 0 }, true],
  ["NaN dev", { dev: NaN, ino: 7 }, { dev: NaN, ino: 7 }, true],
  ["missing inode", { dev: 1, ino: undefined }, { dev: 1, ino: undefined }, true],
  ["unsafe integer identity", { dev: 1, ino: 2 ** 53 }, { dev: 1, ino: 2 ** 53 }, true],
] as const;
for (const [name, before, after, opened] of identityFailures) it(`denies ${name}`, async () => {
  const handle = await open(join(root, "a.html"), "r"); const real = await handle.stat(); const close = vi.spyOn(handle, "close");
  const openFile = vi.fn(async () => ({ fd: handle.fd, stat: async () => ({ ...real, ...after, isFile: () => true }), createReadStream: (o: { start: number; end: number; autoClose: true }) => handle.createReadStream(o), close }));
  try {
    const bad = { ...real, ...before, isFile: () => true, isSymbolicLink: () => "symlink" in before && before.symlink };
    // `missing inode` deliberately models malformed native metadata at the seam.
    await expect(createWorkspaceFileViewOpener({ platform: "win32", open: openFile as FileViewDependencies["open"], lstat: async () => bad as FileViewLstat })(root, "a.html")).rejects.toMatchObject({ status: 403, message: denied });
    expect(openFile.mock.calls.length).toBe(opened ? 1 : 0); expect(close.mock.calls.length).toBe(opened ? 1 : 0);
  } finally { if (!opened) await handle.close(); }
});
```

Node constants do not expose O_ACCMODE on all supported typings; independently assert the read/write bit mask with `(flags & (constants.O_WRONLY | constants.O_RDWR)) === 0` while still asserting exact numeric flags equality. Cover mismatches, missing/NaN/negative/unsafe values independently in both dev and ino and on both lstat and fstat. A missing field uses a narrow documented cast only at that malformed-native boundary.

- [ ] **Step 2: Add `rejects a real Unix-domain socket target with 415` and the bounded FIFO test, then run the focused file.** Native socket fixture uses node:net `createServer().listen(join(root,"socket.html"))`; capture real pre-handle errno Linux ENXIO / Darwin EOPNOTSUPP, assert 415, and close the server in finally. Add injected open rows for both errnos on any host. Windows or unavailable native fixture reports an explicit skip.

The FIFO probe lives as an inline child module string in this same test file, loaded using `spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] })`. Use `spawnSync("mkfifo", [fifoPath])` only to create the fixture. The child imports `createWorkspaceFileViewOpener` via an absolute file URL computed by the parent, authorizes the real root, then sends `ready` from its injected `open` seam immediately before awaiting a `go` IPC message; it delegates that open to fs.open using the actual passed flags. Parent installs all message/exit/error handlers first, waits for ready under a separate startup deadline, records `performance.now()`, arms a 1000ms deadline, and sends go. Child reports `{ status: error.status, message: error.message }` and disconnects/exits. Parent asserts status 415, exact unsupported message, and elapsed <=1000ms. On timeout it kills/reaps the child and fails `FIFO open exceeded 1000 ms`; never await a stuck child indefinitely. On supporting POSIX hosts this named case is `rejects a FIFO without a writer within the parent-owned deadline`. Removing only O_NONBLOCK in a disposable copy must produce that bounded failure rather than a hung Vitest worker.

- [ ] **Step 3: Add the complete stage/cleanup table with real close spies.** The case names are `closes every handle on <post-open failure>` for fstat rejection, nonregular, invalid size (negative/NaN/unsafe/fractional), oversized, Windows mismatch, Linux lookup failure, unknown kind, createReadStream throw, and zero-size push failure. Each case opens a real file handle, overrides only its failing method or metadata, invokes the real opener, asserts exact error/status and close once. For zero-size push failure, wrap the real constructed stream's `push` to throw only on the service's EOF setup, record stream close, and ensure the handle close does not deadlock behind a live stream. For cleanup rejection, make close reject after actually closing and assert the primary FileViewError survives with cleanup diagnostic cause; never report served success.

Add `maps authorization-stage target permission and loop errors to 403` using a mode-000 ancestor and cyclic target symlink plus injected EACCES/EPERM/ELOOP authorize controls; open spy remains zero. Add `maps root-stage canonicalization failures to 500` by asserting the service rethrows PathAccessRootError for workspace/allowed roots: missing, regular-file, cyclic, and ancestor-traversal-denied; include a mode-000 root that canonicalizes and produces later target 403. Route 500 translation follows in Task 14. Add `maps open-stage permission errors to 403 and unexpected filesystem errors to rejection` using real authorize plus an injected open rejecting EACCES/EPERM/ELOOP vs EIO, and ENOENT/ENOTDIR =>404. Keep primary ordinary EIO/error identity unchanged. Test whitespace-only filename as a real text filename to prove it is not trimmed.

- [ ] **Step 4: Rerun `npm test -- --run src/server/workspaces/fileViewService.test.ts` and `npm run typecheck`.** Run isolated mutations in a disposable copy for no-follow, nonblock, Linux containment/failure, handle-stream identity, measured end, zero-size EOF, and Windows usable identity. Record passing baseline and the exact named killer for each; do not count missing tooling/import failures as kills. Fix only contract violations revealed in this service, then rerun the same focused file.
- [ ] **Step 5: Commit.**

```bash
git add src/server/workspaces/fileViewService.ts src/server/workspaces/fileViewService.test.ts
git commit -m "test(files): pin platform open races and handle cleanup"
```

## Task 13: Own HTTP byte counting, final-header flush, and stream teardown

**Implementer tier:** Advanced
**Lane:** file-service
**Dependencies:** Task 11, Task 12

**Files:**

- Create: `src/server/http/fileViewReply.ts`
- Test: `src/server/http/fileViewReply.test.ts`

**Interfaces:**

- Consumes `WorkspaceFileView = { path: string; kind: "document" | "pdf" | "image" | "text"; mediaType: string; size: number; modifiedAt: string; stream: ReadStream }` from Task 11 and `MAX_FILE_VIEW_BYTES = 64 * 1024 * 1024` from Task 1.
- Consumes existing `ReplyDisconnectScope = { readonly signal: AbortSignal; dispose(): void }` and `createReplyDisconnectScope(reply: FastifyReply): ReplyDisconnectScope` from `src/server/http/replyDisconnect.ts`.
- Produces `FILE_VIEW_DOCUMENT_CSP: string` with the exact global policy and `sendWorkspaceFileView(reply: FastifyReply, view: WorkspaceFileView, disconnect: ReplyDisconnectScope): Promise<FastifyReply>`; ownership of both stream and scope transfers on entry, even for an already disconnected reply.

- [ ] **Step 1: Add real-listener HTTP tests and independently literal expected headers.** The kind-row family implements specification 10.7's `does not set document CSP on PDF image or text responses`; the truncation rows implement `aborts a file truncated to <remaining bytes> after fstat`, substituting `2` and `0`. Define the local fixtures below and record events before releasing any source barrier. Use a file-backed ReadStream in every byte-integrity test, not Readable.from as a substitute for file lifetime.

```ts
import Fastify from "fastify";
import compress from "@fastify/compress";
import http from "node:http";
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { createReplyDisconnectScope } from "./replyDisconnect.js";
import { sendWorkspaceFileView } from "./fileViewReply.js";
import type { WorkspaceFileView } from "../workspaces/fileViewService.js";
const policy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function replyFixture(body: Buffer, kind: WorkspaceFileView["kind"] = "document", mediaType = "text/html; charset=utf-8", compression = false) {
  const root = await mkdtemp(join(tmpdir(), "view-reply-")); const path = join(root, "a.html"); await writeFile(path, body);
  const handle = await open(path, "r"); const measured = await handle.stat();
  const stream = handle.createReadStream({ start: 0, end: body.length ? body.length - 1 : 0, autoClose: true }); if (!body.length) stream.push(null);
  const go = deferred<void>(); const entered = deferred<void>();
  const app = Fastify({ logger: false }); if (compression) await app.register(compress, { threshold: 1024 });
  let scopeDisposed = 0;
  app.get("/", async (_r, reply) => {
    const scope = createReplyDisconnectScope(reply); entered.resolve(); await go.promise;
    const view = { path: "a.html", kind, mediaType, size: measured.size, modifiedAt: measured.mtime.toISOString(), stream };
    return sendWorkspaceFileView(reply, view, { signal: scope.signal, dispose: () => { scopeDisposed++; scope.dispose(); } });
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, url, path, stream, go, entered, get disposed() { return scopeDisposed; }, async close() { stream.destroy(); await app.close(); await rm(root, { recursive: true, force: true }); } };
}
function observe(url: string, headers: http.OutgoingHttpHeaders = {}, onHeaders?: (response: http.IncomingMessage) => void) {
  const header = deferred<http.IncomingMessage>(); const first = deferred<void>();
  const result = new Promise<{ ended: boolean; aborted: boolean; bytes: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const chunks: Buffer[] = []; let settled = false; let response: http.IncomingMessage | undefined;
    const finish = (ended: boolean, aborted: boolean) => { if (settled) return; settled = true; clearTimeout(deadline); resolve({ ended, aborted, bytes: Buffer.concat(chunks), headers: response?.headers ?? {} }); };
    const request = http.get(url, { headers }, (r) => {
      response = r; header.resolve(r); onHeaders?.(r);
      r.on("data", (chunk: Buffer) => { chunks.push(chunk); first.resolve(); });
      r.once("end", () => finish(true, false)); r.once("aborted", () => finish(false, true)); r.once("error", () => finish(false, true));
    });
    const deadline = setTimeout(() => { request.destroy(); reject(new Error("HTTP observation deadline")); }, 3000);
    request.on("error", (error) => { if (response) finish(false, true); else { clearTimeout(deadline); reject(error); } });
  });
  return { result, header: header.promise, first: first.promise };
}
function common(headers: http.IncomingHttpHeaders): void {
  expect(headers["cache-control"]).toBe("no-store"); expect(headers["x-content-type-options"]).toBe("nosniff"); expect(headers["referrer-policy"]).toBe("no-referrer");
  for (const name of ["content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"]) expect(headers[name]).toBeUndefined();
}
it("streams an exact body without fixed Content-Length and closes the handle", async () => {
  const f = await replyFixture(Buffer.from("hello")); const response = observe(f.url);
  try { await f.entered.promise; f.go.resolve(); const r = await response.result; expect(r.ended).toBe(true); expect(r.aborted).toBe(false); expect(r.bytes.toString()).toBe("hello"); common(r.headers); await vi.waitFor(() => expect(f.stream.closed).toBe(true)); }
  finally { await f.close(); }
});
it("sets the independently specified full document policy for HTML and SVG", async () => {
  for (const type of ["text/html; charset=utf-8", "image/svg+xml"]) {
    const f = await replyFixture(Buffer.from("document"), "document", type); const response = observe(f.url);
    try { await f.entered.promise; f.go.resolve(); const r = await response.result; common(r.headers); expect(r.headers["content-type"]).toBe(type); expect(r.headers["content-security-policy"]).toBe(policy); }
    finally { await f.close(); }
  }
});
it.each([["pdf", "application/pdf"], ["image", "image/png"], ["text", "text/plain; charset=utf-8"]] as const)("does not set document CSP on %s responses", async (kind, type) => {
  const f = await replyFixture(Buffer.from("data"), kind, type); const response = observe(f.url);
  try { await f.entered.promise; f.go.resolve(); const r = await response.result; common(r.headers); expect(r.headers["content-type"]).toBe(type); expect(r.headers["content-security-policy"]).toBeUndefined(); }
  finally { await f.close(); }
});
it.each([2, 0])("aborts a file truncated to %i after fstat", async (remaining) => {
  const f = await replyFixture(Buffer.from("hello")); const response = observe(f.url);
  try { await f.entered.promise; await truncate(f.path, remaining); f.go.resolve(); const r = await response.result; expect(r.aborted).toBe(true); expect(r.ended).toBe(false); expect(r.bytes.length).toBeLessThanOrEqual(remaining); await vi.waitFor(() => expect(f.stream.closed).toBe(true)); }
  finally { await f.close(); }
});
it("finishes a genuinely empty file cleanly with no fixed length", async () => {
  const f = await replyFixture(Buffer.alloc(0)); const response = observe(f.url);
  try { await f.entered.promise; f.go.resolve(); const r = await response.result; expect(r.ended).toBe(true); expect(r.bytes).toEqual(Buffer.alloc(0)); common(r.headers); await vi.waitFor(() => expect(f.stream.closed).toBe(true)); }
  finally { await f.close(); }
});
```

Add the remaining independent cases to this fixture: `aborts a source read error without appending an error page` holds the source before its next read, releases one real chunk after headers, then destroys it with EIO; `rejects a counter overflow instead of completing a long body` declares size 2 while the real stream emits five bytes; `closes source and counter when the client disconnects` closes the IncomingMessage after first chunk and records source close/no additional reads; `cleans up an already disconnected reply and a send-setup failure` uses a real reply scope aborted at entry and an injected throwing `reply.send` spy, requiring source close/dispose; `flushes final compression-negotiated headers before releasing the source` uses >1024 repeated bytes, Accept-Encoding gzip, captures content-encoding/CSP in onHeaders before releasing the paused source's read barrier, then gunzipSync compares the exact original bytes. Counter close can be observed at the `reply.send` boundary via a pass-through spy retaining the real send implementation; do not export an internal counter only for tests.

- [ ] **Step 2: Run `npm test -- --run src/server/http/fileViewReply.test.ts`.** Confirm adapter import failure, then that short/zero truncation tests are meaningful with a successful exact/empty baseline.
- [ ] **Step 3: Implement a response-owned counting pipeline.**

```ts
import type { FastifyReply } from "fastify";
import { Transform } from "node:stream";
import type { WorkspaceFileView } from "../workspaces/fileViewService.js";
import type { ReplyDisconnectScope } from "./replyDisconnect.js";
import { MAX_FILE_VIEW_BYTES } from "../../shared/fileViewTypes.js";
export const FILE_VIEW_DOCUMENT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";
export async function sendWorkspaceFileView(reply: FastifyReply, view: WorkspaceFileView, disconnect: ReplyDisconnectScope): Promise<FastifyReply> {
  const source = view.stream; let count = 0; let released = false; let started = false;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > view.size || count > MAX_FILE_VIEW_BYTES) callback(new Error("File-view byte count exceeded measured bound"));
      else callback(null, chunk);
    },
    flush(callback) { callback(count === view.size ? undefined : new Error("File-view stream ended before measured size")); },
  });
  const release = (): void => {
    if (released) return; released = true;
    disconnect.signal.removeEventListener("abort", onDisconnect);
    reply.raw.removeListener("pipe", start); reply.raw.removeListener("finish", onFinish); reply.raw.removeListener("close", onClose);
    disconnect.dispose();
  };
  const abort = (error?: Error): void => { source.destroy(); counter.destroy(); if (!reply.raw.destroyed) reply.raw.destroy(error); };
  const onSourceError = (error: Error): void => { counter.destroy(error); if (!reply.raw.destroyed) reply.raw.destroy(error); };
  const onCounterError = (error: Error): void => { source.destroy(); if (!reply.raw.destroyed) reply.raw.destroy(error); };
  const onDisconnect = (): void => { abort(); release(); };
  const onFinish = (): void => { if (!source.readableEnded) source.destroy(); if (!counter.readableEnded) counter.destroy(); release(); };
  const onClose = (): void => { if (!reply.raw.writableFinished) abort(); release(); };
  const start = (): void => {
    if (started) return; started = true;
    if (disconnect.signal.aborted || reply.raw.destroyed) { onDisconnect(); return; }
    if (!reply.raw.headersSent) reply.raw.flushHeaders();
    source.pipe(counter);
  };
  source.on("error", onSourceError); counter.on("error", onCounterError);
  source.once("close", () => { source.removeListener("error", onSourceError); });
  counter.once("close", () => { counter.removeListener("error", onCounterError); });
  reply.raw.once("finish", onFinish); reply.raw.once("close", onClose);
  disconnect.signal.addEventListener("abort", onDisconnect, { once: true });
  if (disconnect.signal.aborted || reply.raw.destroyed) { onDisconnect(); return reply; }
  try {
    reply.code(200).type(view.mediaType).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
    reply.removeHeader("content-length");
    if (view.kind === "document") reply.header("Content-Security-Policy", FILE_VIEW_DOCUMENT_CSP);
    reply.raw.once("pipe", start);
    return await reply.send(counter);
  } catch (error) {
    source.destroy(); counter.destroy(); release();
    if (reply.raw.headersSent) { if (!reply.raw.destroyed) reply.raw.destroy(error instanceof Error ? error : new Error(String(error))); return reply; }
    throw error;
  }
}
```

Observe both error sources until each closes. Do not dispose in an immediate finally while streaming or release source reads before raw pipe. No fixed-length or replacement error page after commitment; leave Fastify compression negotiation intact.

- [ ] **Step 4: Rerun the focused file, `npm run typecheck`, and `npx eslint src/server/http/fileViewReply.ts src/server/http/fileViewReply.test.ts`.** In a disposable copy remove final byte equality, counter bound, and delayed header start one at a time; each named mechanism must fail its independent test with the unchanged baseline passing.
- [ ] **Step 5: Commit.**

```bash
git add src/server/http/fileViewReply.ts src/server/http/fileViewReply.test.ts
git commit -m "feat(http): stream bounded file previews with exact completion checks"
```

## Task 14: Register read-only local view aliases with exact error and disconnect behavior

**Implementer tier:** Advanced
**Lane:** file-service
**Dependencies:** Task 3, Task 6, Task 10, Task 11, Task 13

**Files:**

- Modify: `src/server/workspaceExplorerRoutes.ts:1-26`, `src/server/workspaceExplorerRoutes.ts:150-170`
- Test: `src/server/workspaceExplorerRoutes.test.ts`

**Interfaces:**

- Consumes Task 11 `WorkspaceFileViewOpener = (rootPath: string, path: string | undefined, pathAccess?: PiWebUiPathAccessConfig) => Promise<WorkspaceFileView>`, `openWorkspaceFileView` with that signature, and `FileViewError(status: 400 | 403 | 404 | 413 | 415, message: string, options?: ErrorOptions)`.
- Consumes Task 13 `sendWorkspaceFileView(reply: FastifyReply, view: WorkspaceFileView, disconnect: ReplyDisconnectScope): Promise<FastifyReply>` and existing `createReplyDisconnectScope(reply: FastifyReply): ReplyDisconnectScope`.
- Consumes existing `resolveWorkspaceContext(projects: ProjectService, workspaces: WorkspaceService, projectId: string, workspaceId: string): Promise<WorkspaceContext>` (`{ project, workspace, root }`) and `pathAccessForWorkspaceContext(context: WorkspaceContext, config: Pick<PiWebUiConfigService, "read"> | undefined): Promise<PiWebUiPathAccessConfig | undefined>` using the Task 3 config projection.
- Produces optional `WorkspaceExplorerRouteOptions.openFileView?: WorkspaceFileViewOpener` in the existing interface and exactly one GET `/projects/:projectId/workspaces/:workspaceId/file/view` for each existing prefix `/api` and `/api/machines/local`; no mutation registration.

- [ ] **Step 1: Add a small real route fixture, full kind/error cross-products, and route-only boundaries.** The failure table implements specification 10.8's `returns <file failure> as an exact plain-text page through <local alias>`, substituting both row labels. Create temporary ProjectStore/ProjectService/WorkspaceService; add a real project via `projects.add({path})`, obtain its main workspace from `workspaces.list(project)`, and register the real explorer module twice. Supply a typed mutable config read provider. Use real file service except an opener spy for arguments/abort cases. Fixture names and bytes match the independent local test data, not imported production expected values.

```ts
const aliases = ["/api", "/api/machines/local"] as const;
const fileErrors = [
  ["missing path", "", 400, "path query parameter is required"],
  ["empty path", "?path=", 400, "path query parameter is required"],
  ["repeated path", "?path=a.html&path=b.html", 400, "path query parameter must be a single string"],
  ["NUL", "?path=a%00.html", 400, "path query parameter must not contain NUL bytes"],
  ["traversal", "?path=..%2Fsecret.html", 403, "PI WEBUI is not allowed to read this path. Add its root under Settings → General → External path access."],
  ["missing target", "?path=missing.html", 404, "File not found: missing.html"],
  ["too large", "?path=huge.html", 413, "File is too large to preview (limit 64 MB)."],
  ["directory", "?path=directory.html", 415, "This file type cannot be previewed in PI WEBUI."],
  ["unsupported", "?path=a.exe", 415, "This file type cannot be previewed in PI WEBUI."],
] as const;
function errorHeaders(r: { headers: Record<string, unknown> }) {
  expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8"); expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff"); expect(r.headers["referrer-policy"]).toBe("no-referrer");
  for (const key of ["content-security-policy", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"]) expect(r.headers[key]).toBeUndefined();
}
for (const alias of aliases) for (const [name, query, status, body] of fileErrors) it(`returns ${name} as an exact plain-text page through ${alias}`, async () => {
  const f = await explorerFixture();
  try { const r = await f.app.inject({ url: `${alias}/projects/${f.project.id}/workspaces/${encodeURIComponent(f.workspace.id)}/file/view${query}` }); expect(r.statusCode).toBe(status); expect(r.body).toBe(body); errorHeaders(r); }
  finally { await f.close(); }
});
```

Add forbidden-root rows with `new URLSearchParams({path: outsideFile})` for each alias. For `serves <kind> through <local alias>`, loop HTML/SVG/PDF/PNG/text and both aliases, compare rawPayload exactly, MIME and common headers, no fixed length, and independently literal full CSP for document rows. Add these named cases with direct assertions: `distinguishes unknown project workspace and infrastructure failures` (404 Project not found / 404 Workspace not found / 500 Unable to preview this file.); `passes hosting-machine effective global and project roots to the opener` (write `.pi-webui/config.json` with project root, supply global root, spy delegates to real opener, assert both roots/order and successful external read, deny unrelated root); `does not decode the path a second time` (real file `a%20.html`, query encodes `%` as `%25`, opener sees literal `%20`); `returns a whole 200 body for a Range request` (Range bytes=0-1 still full 200/no range headers); `keeps default HEAD handling bodyless and closes the created stream` (real listener, empty body/closed stream and positive same-file GET); `releases a stream returned after the reply disconnects during open` (promise barrier opener signals entered, client closes response/request, resolve real view, stream closes and no successful send). Validation failures must show zero workspace/opener work; config/store rejection logs details but generic body.

- [ ] **Step 2: Run `npm test -- --run src/server/workspaceExplorerRoutes.test.ts`.** Expect missing GET alias failures before implementation; existing `/file` and `/file/preview` keep their old behavior.
- [ ] **Step 3: Add imports, the optional opener field, and this route inside registerWorkspaceExplorerRoutes.**

```ts
app.get<{ Params: { projectId: string; workspaceId: string }; Querystring: { path?: unknown } }>(`${prefix}/projects/:projectId/workspaces/:workspaceId/file/view`, async (request, reply) => {
  const plain = (status: number, message: string) => reply.code(status).type("text/plain; charset=utf-8").header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer").send(message);
  const path = request.query.path;
  if (path !== undefined && typeof path !== "string") return plain(400, "path query parameter must be a single string");
  if (path === undefined || path === "") return plain(400, "path query parameter is required");
  if (path.includes("\0")) return plain(400, "path query parameter must not contain NUL bytes");
  const disconnect = createReplyDisconnectScope(reply);
  const abandoned = () => disconnect.signal.aborted || reply.raw.destroyed;
  if (abandoned()) { disconnect.dispose(); return reply; }
  try {
    let context: Awaited<ReturnType<typeof resolveWorkspaceContext>>;
    try { context = await resolveWorkspaceContext(projects, workspaces, request.params.projectId, request.params.workspaceId); }
    catch (error) {
      disconnect.dispose(); if (abandoned()) return reply;
      if (error instanceof ProjectNotFoundError) return plain(404, "Project not found");
      if (error instanceof Error && error.message === "Workspace not found") return plain(404, "Workspace not found");
      throw error;
    }
    if (abandoned()) { disconnect.dispose(); return reply; }
    const access = await pathAccessForWorkspaceContext(context, options.config);
    if (abandoned()) { disconnect.dispose(); return reply; }
    const view = await (options.openFileView ?? openWorkspaceFileView)(context.root, path, access);
    if (abandoned()) { view.stream.on("error", (error) => request.log.error({ err: error }, "abandoned file view failed")); view.stream.destroy(); disconnect.dispose(); return reply; }
    return await sendWorkspaceFileView(reply, view, disconnect);
  } catch (error) {
    disconnect.dispose(); if (abandoned()) return reply;
    if (reply.raw.headersSent) { reply.raw.destroy(error instanceof Error ? error : new Error(String(error))); return reply; }
    if (error instanceof FileViewError) return plain(error.status, error.message);
    request.log.error({ err: error }, "unable to preview workspace file");
    return plain(500, "Unable to preview this file.");
  }
});
```

Import `ProjectNotFoundError`, service error/opener/types, reply helper, and disconnect factory; add `openFileView?: WorkspaceFileViewOpener` to the existing exported options. Do not add a route finally that releases streaming scope. Node normal query parsing owns the single decode.

- [ ] **Step 4: Rerun the focused file plus `npm run typecheck`.** Verify both alias inventories, exact bodies without newline, stage-specific 404/500, Range behavior, and disconnect cleanup.
- [ ] **Step 5: Commit.**

```bash
git add src/server/workspaceExplorerRoutes.ts src/server/workspaceExplorerRoutes.test.ts
git commit -m "feat(files): expose read-only workspace file view aliases"
```

## Task 15: Federate the GET view and preserve remote response policy and failures

**Implementer tier:** Standard
**Lane:** file-service
**Dependencies:** Task 3, Task 9, Task 13, Task 14

**Files:**

- Modify: `src/shared/federatedRoutes.ts:1-240`
- Modify: `src/server/machines/machineProxyRoutes.ts:14-22`
- Test: `src/shared/federatedRoutes.test.ts`
- Modify: `src/server/app.remoteProxy.test.ts:1-34`, `src/server/app.remoteProxy.test.ts:740-828`

**Interfaces:**

- Consumes Task 14 GET route `/api/projects/:projectId/workspaces/:workspaceId/file/view?path=<once-query-decoded value>` and Task 13 raw stream/CSP/no-store/nosniff/no-referrer contract; no Content-Length on successful mutable views.
- Consumes Task 3 `parsePiWebUiConfigResponseBody(value: unknown, source?: string): PiWebUiConfigResponse` and `selectedMachineConfigResponse(response: PiWebUiConfigResponse): PiWebUiConfigResponse`, both retaining `allowedOrigins?: string[]` in config/effectiveConfig.
- Produces exactly `{ method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/view" }` in `FEDERATED_HTTP_ROUTES`, no timeout override or WebSocket/mutation counterpart; adds lowercase `referrer-policy` to the private safe response header set.
- Retains existing `MachineClient.request(method: string, path: string, body?: unknown, options?: MachineRequestOptions): Promise<MachineHttpResponse>` with GET signal/cancellation, eager flush, and existing 502/504 envelopes. Browser Origin and Range remain unforwarded.

- [ ] **Step 1: Add literal route inventory tests and extend the existing nonlocal harness.**

```ts
// src/shared/federatedRoutes.test.ts
import { expect, it } from "vitest";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES } from "./federatedRoutes.js";
it("federates exactly one GET workspace file view route", () => {
  expect(FEDERATED_HTTP_ROUTES.filter((s) => s.path === "/projects/:projectId/workspaces/:workspaceId/file/view")).toEqual([{ method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/view" }]);
});
it("adds no mutation or socket counterpart for file view", () => {
  expect(FEDERATED_HTTP_ROUTES.filter((s) => s.path.endsWith("/file/view") && s.method !== "GET")).toEqual([]);
  expect(FEDERATED_WEBSOCKET_ROUTES.filter((p) => p.endsWith("/file/view"))).toEqual([]);
});
```

Use registerAppTestHooks/appTestContext/fakeRemoteClient unchanged. Create a real registered nonlocal machine via the existing POST `/api/machines` fixture style; use its returned id, never pretend local is remote. The forward test's exact data/assertions are:

```ts
const documentPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";
it("forwards file view bytes and every required document header from a nonlocal machine", async () => {
  const request = vi.fn<MachineClient["request"]>(async () => ({ statusCode: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": documentPolicy, "set-cookie": "secret=blocked" }, body: Readable.from([Buffer.from("<p>remote</p>")]) }));
  const machineId = await addRemoteMachine(request);
  const r = await appTestContext.app.inject({ url: `/api/machines/${encodeURIComponent(machineId)}/projects/p%20%2F%3F/workspaces/w%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html`, headers: { range: "bytes=0-1", origin: "https://browser.example" } });
  expect(r.statusCode).toBe(200); expect(r.body).toBe("<p>remote</p>");
  expect(r.headers["content-security-policy"]).toBe(documentPolicy); expect(r.headers["referrer-policy"]).toBe("no-referrer");
  expect(r.headers["cache-control"]).toBe("no-store"); expect(r.headers["x-content-type-options"]).toBe("nosniff"); expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(r.headers["content-length"]).toBeUndefined(); expect(r.headers["set-cookie"]).toBeUndefined();
  expect(request.mock.calls[0]?.slice(0, 3)).toEqual(["GET", "/api/projects/p%20%2F%3F/workspaces/w%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html", undefined]);
  expect(request.mock.calls[0]?.[3]).toEqual({ signal: expect.any(AbortSignal) });
});
```

Add `forwards exact plain-text file view failure status body and headers` as six status/body rows 400 required-path /403 guidance /404 File not found: missing.html /413 limit /415 unsupported /500 generic; compare body/MIME/common headers unchanged. Add `preserves an interrupted upstream file view as an interrupted downstream transfer` using the file's existing real-listener delayed Readable pattern: flush headers, emit partial bytes, destroy upstream, require downstream aborted/no clean end/no appended gateway JSON. Add `preserves allowedOrigins through remote selected-machine config reads and writes` with populated/default-port normalized and explicit [] response rows; inspect both response fields and exact forwarded PUT patch, then malformed response field must fail at `Remote machine config response`. Retain existing missing-machine/offline/timeout controls (404/502/504 JSON) without recategorizing them as file-view text.

- [ ] **Step 2: Run `npm test -- --run src/shared/federatedRoutes.test.ts src/server/app.remoteProxy.test.ts`.** The new GET inventory and nonlocal dispatch fail before registration, then no-referrer must fail until allowlisted.
- [ ] **Step 3: Add the one route record and one header string.**

```ts
{ method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/view" },
```

```ts
"referrer-policy",
```

Make no other proxy transport/client changes; config forwarding already consumes Task 3 parser/projection. A safe GET with foreign Origin is allowed by the guard but does not forward that Origin to the remote.

- [ ] **Step 4: Rerun the focused command and `npm run typecheck`.** Confirm encoded query bytes, every header, interrupted transfer, empty-origin config clearing, and existing gateway error envelopes.
- [ ] **Step 5: Commit.**

```bash
git add src/shared/federatedRoutes.ts src/server/machines/machineProxyRoutes.ts src/shared/federatedRoutes.test.ts src/server/app.remoteProxy.test.ts
git commit -m "feat(federation): proxy read-only file views with document policy"
```

## Task 16: Let file candidates survive Markdown sanitization without admitting active schemes

**Implementer tier:** Standard
**Lane:** client-links
**Dependencies:** Task 1, Task 15

**Files:**

- Modify: `src/client/src/formatting/markdown.ts:169-177`
- Modify: `src/client/src/formatting/markdown.test.ts:1-420`

**Interfaces:**

- Consumes existing `toSafeMarkdownHtml(markdown: string, options?: MarkdownRenderOptions): string` and its private `isSafeUrl(url: string): boolean`; keep sanitizer private and cache keyed only by content.
- Produces additional accepted relative/drive/file URL attributes, retaining raw attribute bytes and existing `_blank` / `noreferrer noopener` anchor decoration. Produces private `decodeFileUrlInspection(value: string): string` only inside markdown.ts; no exported URL parser and no workspace context.
- Consumes no earlier new function: Task 1 classification belongs to recognition, not sanitization; dependency Task 15 establishes the authorized serving boundary before generated links are exposed.

- [ ] **Step 1: Add link/image attribute tests through real Marked and sanitized DOM.** Canonical specification 10.4 table families are `preserves <safe candidate> on <attribute>` and `removes <unsafe scheme> from <attribute>`; each row substitutes the candidate/scheme and href/src labels. Use jsdom in this test file; restore the math renderer/cache as existing hooks require. Valid Markdown spelling and actual DOM attributes are the assertions.

```ts
function markdownAttribute(destination: string, image: boolean): Element {
  const template = document.createElement("template");
  template.innerHTML = toSafeMarkdownHtml(`${image ? "!" : ""}[local](<${destination}>)`);
  const element = template.content.querySelector(image ? "img" : "a"); if (!element) throw new Error("Missing Markdown element"); return element;
}
const safeCandidates = [
  ["a.html", "a.html"], ["./a.html", "./a.html"], ["../a.html", "../a.html"], ["/ramdisk/a.html", "/ramdisk/a.html"],
  ["?view=a.html", "?view=a.html"], ["//cdn.example/a.png", "//cdn.example/a.png"],
  ["C:/Work/a.html", "C:/Work/a.html"], [String.raw`C:\Work\Repo\a.html`, "C:%5CWork%5CRepo%5Ca.html"],
  ["file:///ramdisk/a.html", "file:///ramdisk/a.html"], ["file://localhost/ramdisk/a.html", "file://localhost/ramdisk/a.html"], ["notes/a:b.txt", "notes/a:b.txt"],
] as const;
for (const image of [false, true]) for (const [source, expected] of safeCandidates) it(`preserves ${source} on ${image ? "src" : "href"}`, () => expect(markdownAttribute(source, image).getAttribute(image ? "src" : "href")).toBe(expected));
for (const image of [false, true]) for (const scheme of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,hello", "vbscript:msgbox(1)", "unknown:thing", "java%09script:alert(1)", "java%0Ascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)"]) it(`removes ${JSON.stringify(scheme)} from ${image ? "src" : "href"}`, () => {
  expect(markdownAttribute(scheme, image).hasAttribute(image ? "src" : "href")).toBe(false);
});
it("retains external anchor target and rel behavior", () => {
  for (const target of ["http://example.test/a", "https://example.test/a", "mailto:user@example.test", "#part"]) {
    const a = markdownAttribute(target, false); expect(a.getAttribute("href")).toBe(target); expect(a.getAttribute("target")).toBe("_blank"); expect(a.getAttribute("rel")).toBe("noreferrer noopener");
  }
});
it("caches only the written file targets", () => {
  const text = "[local](a.html) ![plot](plot.svg)";
  const first = toSafeMarkdownHtml(text); expect(toSafeMarkdownHtml(text)).toBe(first);
  expect(first).toContain('href="a.html"'); expect(first).toContain('src="plot.svg"'); expect(first).not.toContain("/file/view"); expect(first).not.toContain("data-file-preview");
});
it("keeps encoded Windows drive destinations for links and images", () => {
  for (const image of [false, true]) {
    const attribute = image ? "src" : "href";
    expect(markdownAttribute(String.raw`C:\Work\Repo\a.html`, image).getAttribute(attribute)).toBe("C:%5CWork%5CRepo%5Ca.html");
    const template = document.createElement("template");
    template.innerHTML = toSafeMarkdownHtml(`${image ? "!" : ""}[local](${String.raw`C:\\Work\\Repo\\a.html`})`);
    expect(template.content.querySelector(image ? "img" : "a")?.getAttribute(attribute)).toBe("C:%5CWork%5CRepo%5Ca.html");
  }
});
```

If Marked declines a syntactically invalid multiline destination before it creates a URL, use its valid angle-bracket/tab-escape spelling and verify the actual created node. Do not test a publicized sanitizer or assert absence only in the output text. Add encoded-scheme/no-new-privilege controls `%6Aavascript%3Aalert(1)` and `unknown%3Athing` => removed.

- [ ] **Step 2: Run `npm test -- --run src/client/src/formatting/markdown.test.ts`.** Relative/file/encoded-drive rows fail with the existing sanitizer; dangerous scheme controls remain passing.
- [ ] **Step 3: Replace only private URL classification, keeping raw output untouched.**

```ts
function decodeFileUrlInspection(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    for (const run of value.match(/(?:%[0-9a-f]{2})+/giu) ?? []) {
      const bytes = new TextEncoder().encode(decodeURIComponent(run));
      const encoded = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
      if (encoded.toLowerCase() !== run.toLowerCase()) return value;
    }
    return decoded;
  } catch { return value; }
}
function isSafeUrl(url: string): boolean {
  const raw = url.trim(); const inspection = decodeFileUrlInspection(raw);
  if (/[\u0000-\u001f\u007f]/u.test(url) || /[\u0000-\u001f\u007f]/u.test(inspection)) return false;
  if (/^[A-Za-z]:[\\/]/u.test(inspection)) return true;
  if (/^[#/?]/u.test(raw)) return true;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(raw);
  if (scheme) return ["http", "https", "mailto", "file"].includes(scheme[1]!.toLowerCase());
  // Decoding may reveal an unsafe scheme, but may not invent a newly permitted one.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(inspection)) return false;
  const relative = (value: string) => {
    const boundary = value.search(/[/?#]/u); const first = boundary === -1 ? value : value.slice(0, boundary);
    return !first.includes(":");
  };
  return relative(raw) && relative(inspection);
}
```

Keep the original `attribute.value` when accepted. No preview marker or resolved URL enters cached HTML.

- [ ] **Step 4: Rerun the focused file and `npx eslint src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts`.** Confirm old dangerous-element/event/style removal and external anchor tests remain passing.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/formatting/markdown.ts src/client/src/formatting/markdown.test.ts
git commit -m "feat(markdown): preserve safe local file destinations for enhancement"
```

## Task 17: Resolve file candidates through one encoded application URL boundary

**Implementer tier:** Advanced
**Lane:** client-links
**Dependencies:** Task 1, Task 15, Task 16

**Files:**

- Modify: `src/client/src/api/urls.ts:38-59`
- Modify: `src/client/src/appUrl.ts:30-35`
- Create: `src/client/src/transcriptFileLinks.ts`
- Modify: `src/client/src/api/urls.test.ts:1-260`
- Test: `src/client/src/transcriptFileLinks.test.ts`

**Interfaces:**

- Consumes Task 1 `fileViewKindForPath(path: string): "document" | "pdf" | "image" | "text" | undefined`, existing `Workspace = { id: string; projectId: string; path: string; label: string; isMain: boolean; isGitRepo: boolean; isGitWorktree: boolean; branch?: string; effectiveConfig?: WorkspaceEffectiveConfig }`, and Task 16 real sanitizer attributes.
- Produces `workspaceFileViewUrl(projectId: string, workspaceId: string, path: string, options?: { machineId?: string }): string` in api/urls.ts; returns an absolute browser URL through `resolveAppUrl(reference)` exactly once.
- Exposes existing `browserAppUrlContext(): AppUrlContext`, where `AppUrlContext = { viteBaseUrl: string; documentBaseUrl: string }`, without changing its implementation.
- Produces `TranscriptFileLinkContext = { cwd: string; projectId: string; workspaceId: string; machineId: string; appBasePath: string }`, `resolveTranscriptFilePreviewUrl(rawTarget: string, context: TranscriptFileLinkContext): string | undefined`, and `transcriptFileLinkContext(sessionCwd: string | undefined, workspaces: readonly Workspace[], machineId: string, appBasePath: string): TranscriptFileLinkContext | undefined`.

- [ ] **Step 1: Add URL and resolver table tests in jsdom, with real URL helpers.** Canonical specification 10.3 table families are `resolves <candidate>`, `declines <non-file target>`, and `excludes <application namespace form>`; expand each row with its explicit label. Stub Vite BASE_URL to `./`, install a document `<base href="https://gateway.example/">` or nested `https://gateway.example/tools/pi/`, and restore env/base nodes after each test. No remote host belongs in resolver context. Use these independent literal expectations and cases:

```ts
const context = { cwd: "/ramdisk", projectId: "project /?", workspaceId: "workspace ?/", machineId: "remote /?", appBasePath: "/" };
const candidates = [
  ["root cwd child HTML", "/ramdisk/pelican-bicycle.html", "pelican-bicycle.html", ""],
  ["cwd child unknown extension", "/ramdisk/output.unknown", "output.unknown", ""],
  ["cwd exact root", "/ramdisk", ".", ""], ["relative HTML", "a.html", "a.html", ""],
  ["./-relative PDF", "././reports/a.pdf", "reports/a.pdf", ""],
  ["root external PNG preserved absolute", "/outside/a.png", "/outside/a.png", ""],
  ["empty-authority file URL", "file:///ramdisk/a.html", "a.html", ""],
  ["localhost file URL", "file://localhost/ramdisk/a.html#part", "a.html", "#part"],
  ["uppercase file scheme", "FILE:///ramdisk/a.pdf?download=1#page=3", "a.pdf", "#page=3"],
  ["encoded Unicode/space filename", "caf%C3%A9%20plot.html", "café plot.html", ""],
  ["encoded literal ?/#", "a%3F%23.html?discard=yes#part", "a?#.html", "#part"],
  ["literal plus", "a+b.html", "a+b.html", ""], ["malformed percent fallback", "a%ZZ.html", "a%ZZ.html", ""],
  ["invalid UTF-8 fallback", "a%FF.html", "a%FF.html", ""], ["once-only %2520 decode", "a%2520.html", "a%20.html", ""],
  ["dropped query", "a.html?discard=yes", "a.html", ""], ["PDF page fragment", "a.pdf#page=3", "a.pdf", "#page=3"],
  ["query plus fragment", "a.pdf?download=1#page=3", "a.pdf", "#page=3"],
  ["query inside fragment", "a.html#part?still-fragment", "a.html", "#part?still-fragment"],
] as const;
for (const [name, raw, path, hash] of candidates) it(`resolves ${name}`, () => {
  const result = resolveTranscriptFilePreviewUrl(raw, context); expect(result).toBeDefined(); const url = new URL(result!);
  expect(url.origin).toBe("https://gateway.example");
  expect(url.pathname).toBe("/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view");
  expect(url.searchParams.get("path")).toBe(path); expect(url.hash).toBe(hash);
});
it.each(["", "   ", "#part", "?view=a.html", "http://outside.example/a.html", "https://outside.example/a.html", "mailto:user@example.test", "javascript:alert(1)", "//cdn.example/a.svg", "a.exe", "README", "/outside/README", "file://otherhost/ramdisk/a.html", "file://u:p@localhost/ramdisk/a.html", "file://localhost:123/ramdisk/a.html", "file:relative.html", "file:/ramdisk/a.html", String.raw`\\server\share\a.pdf`])("declines %s", (raw) => expect(resolveTranscriptFilePreviewUrl(raw, context)).toBeUndefined());
for (const namespace of ["api", "pi-webui-plugins", "assets"]) for (const prefix of ["", "./", "/", "encoded"]) it(`excludes ${prefix} ${namespace}`, () => {
  const raw = prefix === "encoded" ? `%${namespace.charCodeAt(0).toString(16)}${namespace.slice(1)}/a.html` : `${prefix}${namespace}/a.html`;
  expect(resolveTranscriptFilePreviewUrl(raw, context)).toBeUndefined();
});
it("does not strip a near cwd prefix", () => expect(new URL(resolveTranscriptFilePreviewUrl("/ramdisk2/a.html", context)!).searchParams.get("path")).toBe("/ramdisk2/a.html"));
it("excludes a nested effective base without excluding its near-prefix or root deployment", () => {
  expect(resolveTranscriptFilePreviewUrl("/tools/pi/a.html", { ...context, appBasePath: "/tools/pi/" })).toBeUndefined();
  expect(new URL(resolveTranscriptFilePreviewUrl("/tools/piano/a.html", { ...context, appBasePath: "/tools/pi/" })!).searchParams.get("path")).toBe("/tools/piano/a.html");
  expect(new URL(resolveTranscriptFilePreviewUrl("/ramdisk/a.html", context)!).searchParams.get("path")).toBe("a.html");
  expect(new URL(resolveTranscriptFilePreviewUrl("apian/a.html", context)!).searchParams.get("path")).toBe("apian/a.html");
});
it("retains traversal for the server authorization boundary", () => expect(new URL(resolveTranscriptFilePreviewUrl("../a.html", context)!).searchParams.get("path")).toBe("../a.html"));
```

Add `resolves Marked-encoded Windows drive attributes`: render real Markdown for angle-bracket drive, `file:///C:\Work\Repo\a.html`, and localhost file forms, read the actual sanitized href, assert encoded C:%5C spellings, then resolve cwd C:/Work/Repo and exact path a.html. Add `recognizes Windows paths before schemes and compares drive paths case-insensitively`: raw slash/backslash/mixed case plus file URL => preserved-case remainder, C:/Work/Repo2 stays absolute, POSIX case difference stays absolute. Add `preserves filesystem roots during cwd comparison`: cwd `/` and `C:/`, child =>a.html and exact =>`.`. Add `returns context for the matching workspace rather than the selected-looking first workspace`: two fully typed Workspace fixtures with match second, exact ids. Add `normalizes context comparisons only for slash and Windows case rules`: trailing separators, slash conversions, Windows case, significant whitespace, POSIX nonmatch, no dot-segment collapse. Add `disables context and direct resolution for incomplete ownership`: no cwd/no match/empty ids/machine/invalid app pathname =>undefined in both functions.

URL test names and literal expected values are mandatory: `builds an encoded browser-ready file view URL on the current origin`, `defaults file view URLs to the local machine`, and `resolves file view URLs exactly once beneath the effective nested base`. For nested base assert the full literal `https://gateway.example/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=dir%2Fa+%3F%23%25%2B.html`; omitted machine uses `/api/machines/local/projects/p/workspaces/w/file/view?path=a.html` on that current app origin, no fragment.

- [ ] **Step 2: Run `npm test -- --run src/client/src/api/urls.test.ts src/client/src/transcriptFileLinks.test.ts`.** Missing helper/resolver exports fail; no test computes the expected URL by invoking the helper under test.
- [ ] **Step 3: Implement the helper and recognition algorithm.** Add `export` to browserAppUrlContext without changing its body.

```ts
// api/urls.ts
export function workspaceFileViewUrl(projectId: string, workspaceId: string, path: string, options?: { machineId?: string }): string {
  const params = new URLSearchParams({ path });
  return resolveAppUrl(`api/machines/${encodeURIComponent(options?.machineId ?? "local")}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/file/view?${params.toString()}`);
}
```

```ts
// transcriptFileLinks.ts
import type { Workspace } from "../../shared/apiTypes";
import { fileViewKindForPath } from "../../shared/fileViewTypes";
import { workspaceFileViewUrl } from "./api/urls";
export interface TranscriptFileLinkContext { cwd: string; projectId: string; workspaceId: string; machineId: string; appBasePath: string }
function validBase(path: string): boolean { return /^\/(?!\/)[^?#\\\u0000-\u001f\u007f]*$/u.test(path); }
function normalized(path: string): string {
  const slashes = path.replace(/\\/gu, "/");
  return slashes === "/" || /^[A-Za-z]:\/+$/u.test(slashes) ? (slashes === "/" ? "/" : `${slashes.slice(0, 2)}/`) : slashes.replace(/\/+$/u, "");
}
function drive(path: string): boolean { return /^[A-Za-z]:[\\/]/u.test(path); }
function equalPaths(a: string, b: string): boolean {
  const left = normalized(a); const right = normalized(b);
  return drive(left) && drive(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function decodeOnce(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    for (const run of value.match(/(?:%[0-9a-f]{2})+/giu) ?? []) {
      const bytes = new TextEncoder().encode(decodeURIComponent(run));
      const encoded = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
      if (encoded.toLowerCase() !== run.toLowerCase()) return value;
    }
    return decoded;
  } catch { return value; }
}
export function transcriptFileLinkContext(sessionCwd: string | undefined, workspaces: readonly Workspace[], machineId: string, appBasePath: string): TranscriptFileLinkContext | undefined {
  if (!sessionCwd || !machineId || !validBase(appBasePath)) return undefined;
  const workspace = workspaces.find((candidate) => equalPaths(candidate.path, sessionCwd));
  if (!workspace?.id || !workspace.projectId) return undefined;
  return { cwd: sessionCwd, projectId: workspace.projectId, workspaceId: workspace.id, machineId, appBasePath };
}
export function resolveTranscriptFilePreviewUrl(rawTarget: string, context: TranscriptFileLinkContext): string | undefined {
  if (!context.cwd || !context.projectId || !context.workspaceId || !context.machineId || !validBase(context.appBasePath)) return undefined;
  const raw = rawTarget.trim();
  if (!raw || /^[#?]/u.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\")) return undefined;
  const inspected = decodeOnce(raw); const isDrive = drive(inspected);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(inspected)?.[1]?.toLowerCase();
  if (!isDrive && scheme !== undefined && scheme !== "file") return undefined;
  let path: string; let fragment = ""; let fromFile = false;
  if (!isDrive && scheme === "file") {
    if (!/^file:\/\//iu.test(raw)) return undefined;
    let url: URL; try { url = new URL(raw); } catch { return undefined; }
    if ((url.hostname !== "" && url.hostname !== "localhost") || url.username || url.password || url.port) return undefined;
    path = url.pathname; fragment = url.hash; fromFile = true;
  } else {
    const hash = raw.indexOf("#"); const beforeHash = hash < 0 ? raw : raw.slice(0, hash);
    if (hash >= 0) fragment = raw.slice(hash);
    const query = beforeHash.indexOf("?"); path = query < 0 ? beforeHash : beforeHash.slice(0, query);
  }
  path = decodeOnce(path).replace(/\\/gu, "/");
  if (fromFile && /^\/[A-Za-z]:/u.test(path)) path = path.slice(1);
  while (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("//")) return undefined;
  const namespace = (path.startsWith("/") ? path.slice(1) : path).split("/", 1)[0];
  if (["api", "pi-webui-plugins", "assets"].includes(namespace ?? "")) return undefined;
  const base = context.appBasePath.replace(/\/+$/u, "");
  if (base && path.startsWith("/") && (path === base || path.startsWith(`${base}/`))) return undefined;
  const absolute = path.startsWith("/") || drive(path); let requestPath = path; let cwdMatch = false;
  if (absolute) {
    const cwd = normalized(context.cwd); const candidate = normalized(path); const fold = drive(cwd) && drive(candidate);
    const comparable = fold ? candidate.toLowerCase() : candidate; const parent = fold ? cwd.toLowerCase() : cwd;
    if (comparable === parent) { requestPath = "."; cwdMatch = true; }
    else {
      const prefix = parent.endsWith("/") ? parent : `${parent}/`;
      if (comparable.startsWith(prefix)) { requestPath = path.slice(prefix.length); cwdMatch = true; }
    }
  }
  if (!cwdMatch && fileViewKindForPath(path) === undefined) return undefined;
  return workspaceFileViewUrl(context.projectId, context.workspaceId, requestPath, { machineId: context.machineId }) + fragment;
}
```

Do not consult browser location inside recognition, normalize `..`, trim filesystem cwd, or catch arbitrary helper errors here. Filesystem roots preserve exactly one separator; extensionless/unknown cwd children still reach server authorization/kind handling.

- [ ] **Step 4: Rerun both focused files, `npm run typecheck`, and `npx eslint src/client/src/transcriptFileLinks.ts src/client/src/transcriptFileLinks.test.ts src/client/src/api/urls.ts src/client/src/api/urls.test.ts src/client/src/appUrl.ts`.** Confirm all normative resolver rows for both application bases and encoded Windows attributes.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/api/urls.ts src/client/src/appUrl.ts src/client/src/transcriptFileLinks.ts src/client/src/api/urls.test.ts src/client/src/transcriptFileLinks.test.ts
git commit -m "feat(client): resolve transcript files on their owning workspace"
```

## Task 18: Enhance and restore FormattedText attributes per DOM instance

**Implementer tier:** Standard
**Lane:** client-links
**Dependencies:** Task 16, Task 17

**Files:**

- Modify: `src/client/src/components/FormattedText.ts:30-44`, `src/client/src/components/FormattedText.ts:78-90`
- Modify: `src/client/src/components/FormattedText.test.ts:1-55`, `src/client/src/components/FormattedText.test.ts:150-206`

**Interfaces:**

- Consumes Task 16 `toSafeMarkdownHtml(markdown: string, options?: MarkdownRenderOptions): string` with original safe href/src values and unchanged content cache; resolver output comes from Task 17 but the component knows only its injected function signature.
- Produces exactly `@property({ attribute: false }) resolveFileLink?: (rawTarget: string) => string | undefined` on FormattedText and private per-instance `WeakMap<Element, { attribute: "href" | "src"; original: string }>` state.
- Produces private `enhanceFileLinks(): void`, invoked on every `updated(): void` pass next to code enhancement; no mutation observer, global map, markdown mutation, or node removal.

- [ ] **Step 1: Add all lifecycle regressions using real mounted elements and the existing mountFormattedText/formattedContainer helpers.** Assign resolvers after initial mounting and await updateComplete; keep text fixed in identity/restoration cases.

```ts
const fileMarkdown = "[local](a.html) ![local](plot.svg) [external](https://outside.example/a.html)";
function fileNodes(element: FormattedText) {
  const root = formattedContainer(element); const a = root.querySelector<HTMLAnchorElement>('a[href]:not([href^="https://outside.example"])'); const img = root.querySelector<HTMLImageElement>("img");
  if (!a || !img) throw new Error("Missing file nodes"); return { a, img };
}
function resolver(prefix: string) { return vi.fn((raw: string) => ["a.html", "plot.svg", "other.html"].includes(raw) ? `${prefix}${raw}` : undefined); }
it("rewrites file anchor and image attributes and marks only matches", async () => {
  const e = await mountFormattedText(fileMarkdown, false); e.resolveFileLink = resolver("https://gateway.example/A/"); await e.updateComplete;
  const { a, img } = fileNodes(e); expect(a.getAttribute("href")).toBe("https://gateway.example/A/a.html"); expect(img.getAttribute("src")).toBe("https://gateway.example/A/plot.svg");
  expect(a.dataset.filePreview).toBe("true"); expect(img.dataset.filePreview).toBe("true"); expect(a.target).toBe("_blank"); expect(a.rel).toBe("noreferrer noopener");
  const external = formattedContainer(e).querySelector('a[href="https://outside.example/a.html"]'); expect(external?.hasAttribute("data-file-preview")).toBe(false);
});
it("keeps the same elements while resolving A then B from the original targets", async () => {
  const e = await mountFormattedText(fileMarkdown, false); const nodes = fileNodes(e); const a = resolver("https://gateway.example/A/"); const b = resolver("https://gateway.example/B/");
  e.resolveFileLink = a; await e.updateComplete; e.resolveFileLink = b; await e.updateComplete;
  expect(fileNodes(e)).toEqual(nodes); expect(fileNodes(e).a).toBe(nodes.a); expect(fileNodes(e).img).toBe(nodes.img);
  expect(a).toHaveBeenCalledWith("a.html"); expect(b).toHaveBeenCalledWith("a.html"); expect(b).toHaveBeenCalledWith("plot.svg");
  expect(b.mock.calls.flat()).not.toContain("https://gateway.example/A/a.html"); expect(nodes.a.getAttribute("href")).toBe("https://gateway.example/B/a.html");
});
it("restores original attributes when a replacement resolver declines", async () => {
  const e = await mountFormattedText(fileMarkdown, false); const nodes = fileNodes(e);
  for (const r of [resolver("https://gateway.example/A/"), resolver("https://gateway.example/B/"), () => undefined]) { e.resolveFileLink = r; await e.updateComplete; }
  expect(fileNodes(e).a).toBe(nodes.a); expect(nodes.a.getAttribute("href")).toBe("a.html"); expect(nodes.img.getAttribute("src")).toBe("plot.svg"); expect(nodes.a.hasAttribute("data-file-preview")).toBe(false); expect(nodes.img.hasAttribute("data-file-preview")).toBe(false);
});
it("restores original attributes when the resolver disappears", async () => {
  const e = await mountFormattedText(fileMarkdown, false); const nodes = fileNodes(e); e.resolveFileLink = resolver("https://gateway.example/B/"); await e.updateComplete;
  e.resolveFileLink = undefined; await e.updateComplete; expect(nodes.a.getAttribute("href")).toBe("a.html"); expect(nodes.img.getAttribute("src")).toBe("plot.svg"); expect(nodes.a.hasAttribute("data-file-preview")).toBe(false);
  e.resolveFileLink = resolver("https://gateway.example/A/"); await e.updateComplete; expect(nodes.a.getAttribute("href")).toBe("https://gateway.example/A/a.html");
});
it("restores a throwing element and continues enhancing its siblings", async () => {
  const e = await mountFormattedText(fileMarkdown, false); e.resolveFileLink = resolver("https://gateway.example/A/"); await e.updateComplete;
  e.resolveFileLink = (raw) => { if (raw === "a.html") throw new Error("resolver failure"); return raw === "plot.svg" ? "https://gateway.example/B/plot.svg" : undefined; }; await e.updateComplete;
  const { a, img } = fileNodes(e); expect(a.getAttribute("href")).toBe("a.html"); expect(a.hasAttribute("data-file-preview")).toBe(false); expect(img.getAttribute("src")).toBe("https://gateway.example/B/plot.svg");
});
it("isolates two workspace resolvers sharing cached Markdown", async () => {
  const a = await mountFormattedText(fileMarkdown, false); const b = await mountFormattedText(fileMarkdown, false);
  a.resolveFileLink = resolver("https://gateway.example/A/"); b.resolveFileLink = resolver("https://gateway.example/B/"); await Promise.all([a.updateComplete, b.updateComplete]);
  expect(fileNodes(a).a.getAttribute("href")).toBe("https://gateway.example/A/a.html"); expect(fileNodes(b).a.getAttribute("href")).toBe("https://gateway.example/B/a.html");
  const cached = toSafeMarkdownHtml(fileMarkdown); expect(cached).toContain('href="a.html"'); expect(cached).toContain('src="plot.svg"'); expect(cached).not.toContain("/file/view"); expect(cached).not.toContain("gateway.example");
});
it("records new originals after Markdown replaces nodes", async () => {
  const e = await mountFormattedText(fileMarkdown, false); e.resolveFileLink = resolver("https://gateway.example/A/"); await e.updateComplete; const old = fileNodes(e).a;
  e.text = "[other](other.html) ![local](plot.svg)"; await e.updateComplete; const current = fileNodes(e).a; expect(current).not.toBe(old);
  e.resolveFileLink = undefined; await e.updateComplete; expect(current.getAttribute("href")).toBe("other.html");
});
it("enhances links when a live plain-text tail settles without changing plain-text rendering", async () => {
  const text = "[local](a.html) $x"; const e = await mountFormattedText(text, true); e.resolveFileLink = resolver("https://gateway.example/A/"); await e.updateComplete;
  expect(formattedContainer(e).textContent).toBe(text); expect(formattedContainer(e).querySelector("a")).toBeNull(); e.live = false; await e.updateComplete;
  expect(formattedContainer(e).querySelector("a")?.getAttribute("href")).toBe("https://gateway.example/A/a.html");
});
```

Add vi and toSafeMarkdownHtml imports to the existing file; preserve its math hooks and DOM cleanup.

- [ ] **Step 2: Run `npm test -- --run src/client/src/components/FormattedText.test.ts`.** Expect new property/enhancement assertions to fail before implementation.
- [ ] **Step 3: Add only the injected property, map, and DOM pass.**

```ts
@property({ attribute: false })
resolveFileLink?: (rawTarget: string) => string | undefined;
private readonly originalFileLinks = new WeakMap<Element, { attribute: "href" | "src"; original: string }>();
private enhanceFileLinks(): void {
  this.renderRoot.querySelectorAll("a[href], img[src]").forEach((element) => {
    let original = this.originalFileLinks.get(element);
    if (original === undefined) {
      const attribute = element.tagName === "A" ? "href" : "src";
      const value = element.getAttribute(attribute); if (value === null) return;
      original = { attribute, original: value }; this.originalFileLinks.set(element, original);
    }
    let resolved: string | undefined;
    try { resolved = this.resolveFileLink?.(original.original); } catch { resolved = undefined; }
    element.setAttribute(original.attribute, resolved ?? original.original);
    if (resolved === undefined) element.removeAttribute("data-file-preview");
    else element.setAttribute("data-file-preview", "true");
  });
}
```

Call `this.enhanceFileLinks();` in updated immediately after enhanceCodeBlocks. Keep every href/src present for restoration and map only actual nodes.

- [ ] **Step 4: Rerun the focused file and `npm run typecheck`.** Confirm A→B, decline, disappearance, exception isolation, replaced nodes, shared cache, and live settlement each have independent passing assertions.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/components/FormattedText.ts src/client/src/components/FormattedText.test.ts
git commit -m "feat(chat): enhance and restore file links per formatted instance"
```

## Task 19: Forward the resolver through all five ChatView surfaces

**Implementer tier:** Standard
**Lane:** client-links
**Dependencies:** Task 18

**Files:**

- Modify: `src/client/src/components/ChatView.ts:1-110`, `src/client/src/components/ChatView.ts:1155-1165`, `src/client/src/components/ChatView.ts:1500-1535`
- Test: `src/client/src/components/ChatView.fileLinks.test.ts`

**Interfaces:**

- Consumes FormattedText `resolveFileLink?: (rawTarget: string) => string | undefined` and its per-element original restoration from Task 18.
- Produces exactly `@property({ attribute: false }) resolveFileLink?: (rawTarget: string) => string | undefined` on ChatView and forwards `.resolveFileLink=${this.resolveFileLink}` at queued-message, message text, thinking, skill invocation, and tool-result sites.
- Retains existing ChatLine, SessionStatus, live-tail behavior, and bash's plain shell-output surface. Queued template covers both server and client queue sources.

- [ ] **Step 1: Create a jsdom real-component test using explicit messages and disclosure.** Its site table implements specification 10.12's `forwards the resolver at <render site>`; substitute queued, message (with user/assistant controls), thinking, skill invocation, and tool result labels.

```ts
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { SessionStatus } from "../api";
import type { ChatLine } from "./shared";
import { ChatView } from "./ChatView";
import type { FormattedText } from "./FormattedText";
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });
const baseStatus: SessionStatus = { sessionId: "s1", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
const messages: ChatLine[] = [
  { role: "user", parts: [{ type: "text", text: "[user](user.html)" }] },
  { role: "assistant", parts: [{ type: "text", text: "[assistant](assistant.html)" }] },
  { role: "assistant", parts: [{ type: "thinking", text: "[thinking](thinking.html)" }] },
  { role: "assistant", parts: [{ type: "skillInvocation", name: "skill", location: "/skill/SKILL.md", content: "[skill](skill.html)" }] },
  { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "[tool](tool.html)", isError: false }] },
  { role: "bash", parts: [{ type: "text", text: "[bash](bash.html)" }] },
];
const children = (v: ChatView) => Array.from(v.shadowRoot?.querySelectorAll<FormattedText>("formatted-text") ?? []);
async function settled(v: ChatView): Promise<void> { await v.updateComplete; await Promise.all(children(v).map((c) => c.updateComplete)); }
async function mounted() {
  const v = new ChatView(); v.sessionId = "s1"; v.messages = messages; v.messageEnd = messages.length; v.messageTotal = messages.length;
  v.status = { ...baseStatus, queuedMessages: [{ kind: "followUp", text: "[queued](queued.html)" }] };
  document.body.append(v); await settled(v);
  for (const details of v.shadowRoot?.querySelectorAll<HTMLDetailsElement>("details.event-group") ?? []) { details.open = true; details.dispatchEvent(new Event("toggle")); }
  await settled(v); return v;
}
for (const [site, targets] of [["queued text", ["queued.html"]], ["message text", ["user.html", "assistant.html"]], ["thinking", ["thinking.html"]], ["skill invocation", ["skill.html"]], ["tool result", ["tool.html"]]] as const) it(`forwards the resolver at ${site}`, async () => {
  const v = await mounted(); const resolver = (raw: string) => `https://gateway.example/view?path=${encodeURIComponent(raw)}`; v.resolveFileLink = resolver; await settled(v);
  for (const target of targets) {
    const child = children(v).find((c) => c.text.includes(`](${target})`)); expect(child).toBeDefined(); expect(child?.resolveFileLink).toBe(resolver);
    expect(child?.shadowRoot?.querySelector("a")?.getAttribute("href")).toBe(`https://gateway.example/view?path=${encodeURIComponent(target)}`);
  }
});
it("updates existing formatted children when the resolver is replaced or removed", async () => {
  const v = await mounted(); const original = children(v); v.resolveFileLink = (raw) => `https://gateway.example/A/${raw}`; await settled(v);
  v.resolveFileLink = (raw) => `https://gateway.example/B/${raw}`; await settled(v); expect(children(v)).toEqual(original);
  for (const child of original) expect(child.shadowRoot?.querySelector("a")?.getAttribute("href")).toContain("https://gateway.example/B/");
  v.resolveFileLink = undefined; await settled(v);
  for (const child of original) { expect(child.resolveFileLink).toBeUndefined(); expect(child.shadowRoot?.querySelector("a")?.getAttribute("href")).toMatch(/^[a-z]+\.html$/u); }
});
it("keeps bash output on its existing plain-text surface", async () => {
  const v = await mounted(); const article = v.shadowRoot?.querySelector("article.msg.bash");
  expect(article?.querySelector(".shell-output")?.textContent).toBe("[bash](bash.html)"); expect(article?.querySelector("formatted-text")).toBeNull();
});
```

Add clientQueuedMessages fixture with a distinct `client-queued.html` target inside the queued-site named test and assert both server and client queue children inherit the same resolver. Do not inspect TemplateResult values or invent an extra Markdown bash surface.

- [ ] **Step 2: Run `npm test -- --run src/client/src/components/ChatView.fileLinks.test.ts`.** Missing property/site bindings must fail named cases individually.
- [ ] **Step 3: Add the production property and all five exact template bindings.**

```ts
@property({ attribute: false })
resolveFileLink?: (rawTarget: string) => string | undefined;
```

At the queued site use `<formatted-text .text=${message.text} .resolveFileLink=${this.resolveFileLink}></formatted-text>`. At part.type text retain `class="part"`, text/live, and add the same binding; at thinking retain its details/summary and add it to the child; at skill and tool-result retain their existing text/live props and add it. There must be exactly five production formatted-text opening tags and exactly five forwarding bindings.

- [ ] **Step 4: Rerun `npm test -- --run src/client/src/components/ChatView.fileLinks.test.ts src/client/src/components/ChatView.latex.test.ts` and `npm run typecheck`.** In a disposable copy delete each binding one at a time; its named site case must fail with the baseline green.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/components/ChatView.ts src/client/src/components/ChatView.fileLinks.test.ts
git commit -m "feat(chat): forward local file resolvers to every transcript surface"
```

## Task 20: Bind session-owned memoized resolvers on the real app template

**Implementer tier:** Advanced
**Lane:** client-links
**Dependencies:** Task 17, Task 18, Task 19

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:1-217`, `src/client/src/components/PiWebUiApp.ts:4814-4820`
- Test: `src/client/src/components/PiWebUiApp.fileLinks.test.ts`

**Interfaces:**

- Consumes Task 17 `TranscriptFileLinkContext = { cwd: string; projectId: string; workspaceId: string; machineId: string; appBasePath: string }`, `transcriptFileLinkContext(sessionCwd: string | undefined, workspaces: readonly Workspace[], machineId: string, appBasePath: string): TranscriptFileLinkContext | undefined`, and `resolveTranscriptFilePreviewUrl(rawTarget: string, context: TranscriptFileLinkContext): string | undefined`.
- Consumes Task 17 `browserAppUrlContext(): { viteBaseUrl: string; documentBaseUrl: string }` and Task 19 ChatView `resolveFileLink?: (rawTarget: string) => string | undefined`.
- Produces private lazy `fileLinkAppBasePath?: string`, private one-entry `{ key: string; resolve: (rawTarget: string) => string | undefined }` memo, and a real `.resolveFileLink` binding inside existing `renderChatView(state: AppState, session: SessionInfo)`.
- Consumes existing `selectedMachineId(state: AppState): string` and state ownership; a workspace must have `candidate.projectId === state.selectedProject.id`. No selectedWorkspace-path equality requirement.

- [ ] **Step 1: Add detached-app real-template tests, avoiding network controller startup.** Use `initialAppState()`, fully typed Project/Workspace/Machine/SessionInfo fixtures, and Lit render of the returned actual renderChatView template. The reflection helper is limited to accessing that existing private boundary, not extracting values or computing a substitute resolver.

```ts
// @vitest-environment jsdom
import { render, type TemplateResult } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { PiWebUiApp } from "./PiWebUiApp";
import type { ChatView } from "./ChatView";
import type { SessionInfo, Workspace } from "../../../shared/apiTypes";
let container: HTMLDivElement; let base: HTMLBaseElement;
beforeEach(() => { vi.stubEnv("BASE_URL", "./"); base = document.createElement("base"); base.href = "https://gateway.example/tools/pi/"; document.head.append(base); container = document.createElement("div"); document.body.append(container); });
afterEach(() => { render(null, container); document.body.replaceChildren(); base.remove(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const workspace = (id: string, path: string, projectId = "project /?"): Workspace => ({ id, path, projectId, label: id, isMain: false, isGitRepo: false, isGitWorktree: false });
const session: SessionInfo = { id: "session-1", cwd: "/second", path: "/second/session.jsonl", created: "2026-11-04T00:00:00.000Z", modified: "2026-11-04T00:00:00.000Z", messageCount: 0, firstMessage: "" };
function stateFixture(): AppState {
  const state = initialAppState();
  state.selectedProject = { id: "project /?", name: "project", path: "/first", createdAt: "2026-11-04T00:00:00.000Z" };
  state.workspaces = [workspace("first", "/first"), workspace("workspace ?/", "/second")]; state.selectedWorkspace = state.workspaces[0]; state.selectedSession = session;
  state.selectedMachine = { id: "remote /?", kind: "remote", name: "remote", baseUrl: "https://machine.example:9999", createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" };
  return state;
}
async function chat(app: PiWebUiApp, state: AppState, selected: SessionInfo = session): Promise<ChatView> {
  Reflect.set(app, "state", state);
  const boundary = Reflect.get(app, "renderChatView") as (state: AppState, session: SessionInfo) => TemplateResult;
  render(boundary.call(app, state, selected), container);
  const child = container.querySelector<ChatView>("chat-view"); if (!child) throw new Error("Missing real chat-view template"); await child.updateComplete; return child;
}
it("binds selected remote session workspace and machine ownership to the rendered chat view", async () => {
  const child = await chat(new PiWebUiApp(), stateFixture());
  expect(child.resolveFileLink?.("/second/a.html")).toBe("https://gateway.example/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view?path=a.html");
});
it("derives nested application exclusion from the effective AppUrlContext", async () => {
  const child = await chat(new PiWebUiApp(), stateFixture()); expect(child.resolveFileLink?.("/tools/pi/report.html")).toBeUndefined();
  const result = child.resolveFileLink?.("/second/a.html"); expect(new URL(result!).pathname).toBe("/tools/pi/api/machines/remote%20%2F%3F/projects/project%20%2F%3F/workspaces/workspace%20%3F%2F/file/view");
});
it("binds undefined when session cwd or selected-project ownership has no match", async () => {
  for (const change of [
    (s: AppState) => { s.selectedProject = undefined; },
    (s: AppState) => { s.workspaces = [workspace("other", "/unmatched")]; },
    (s: AppState) => { s.workspaces = [workspace("other", "/second", "another-project")]; },
    (s: AppState) => { s.workspaces = [workspace("", "/second")]; },
  ]) { const s = stateFixture(); change(s); expect((await chat(new PiWebUiApp(), s)).resolveFileLink).toBeUndefined(); }
});
it("reuses resolver identity only while its complete ownership tuple is equal", async () => {
  const app = new PiWebUiApp(); const s = stateFixture(); const first = (await chat(app, s)).resolveFileLink;
  const equal = { ...s, workspaces: s.workspaces.map((w) => ({ ...w })), isLoadingProjects: true }; expect((await chat(app, equal)).resolveFileLink).toBe(first);
  const otherSession = { ...session, id: "session-2" }; const second = (await chat(app, equal, otherSession)).resolveFileLink; expect(second).not.toBe(first);
  const changedWorkspace = { ...equal, workspaces: [workspace("new", "/second")] }; const third = (await chat(app, changedWorkspace, otherSession)).resolveFileLink; expect(third).not.toBe(second); expect(third?.("a.html")).toContain("/workspaces/new/");
  const local = { ...changedWorkspace, selectedMachine: undefined }; const fourth = (await chat(app, local, otherSession)).resolveFileLink; expect(fourth).not.toBe(third); expect(fourth?.("a.html")).toContain("/machines/local/");
});
```

Extend the tuple case with cwd plus matching workspace change, project id plus matching workspace project change, and absent ownership clearing followed by re-enable; every changed tuple must replace identity and every equal reallocation must reuse it. Add an explicit empty cwd test and a detached/no-document boundary control: construct app while document is unavailable, then render only after restoring globals; no eager URL-state read may occur in its constructor or ownership-failure path.

- [ ] **Step 2: Run `npm test -- --run src/client/src/components/PiWebUiApp.fileLinks.test.ts`.** Missing real chat binding/memo/base behavior must fail.
- [ ] **Step 3: Add lazy resolver preparation and bind it.** Import browserAppUrlContext and the two resolver functions/types; use this private method before constructing the existing chat template:

```ts
private fileLinkAppBasePath?: string;
private fileLinkResolverMemo?: { key: string; resolve: (rawTarget: string) => string | undefined };
private fileLinkResolver(state: AppState, session: SessionInfo): ((rawTarget: string) => string | undefined) | undefined {
  const project = state.selectedProject;
  if (typeof document === "undefined" || project === undefined) { this.fileLinkResolverMemo = undefined; return undefined; }
  const workspaces = state.workspaces.filter((candidate) => candidate.projectId === project.id);
  // Ownership can be checked with a syntactically valid pathname before any browser URL read.
  const ownership = transcriptFileLinkContext(session.cwd, workspaces, selectedMachineId(state), "/");
  if (ownership === undefined) { this.fileLinkResolverMemo = undefined; return undefined; }
  if (this.fileLinkAppBasePath === undefined) {
    const context = browserAppUrlContext(); this.fileLinkAppBasePath = new URL(context.viteBaseUrl, context.documentBaseUrl).pathname;
  }
  const context = transcriptFileLinkContext(session.cwd, workspaces, selectedMachineId(state), this.fileLinkAppBasePath);
  if (context === undefined) { this.fileLinkResolverMemo = undefined; return undefined; }
  const key = JSON.stringify([session.id, context.cwd, context.projectId, context.workspaceId, context.machineId, context.appBasePath]);
  if (this.fileLinkResolverMemo?.key !== key) {
    const pinned: TranscriptFileLinkContext = Object.freeze({ ...context });
    this.fileLinkResolverMemo = { key, resolve: (raw) => resolveTranscriptFilePreviewUrl(raw, pinned) };
  }
  return this.fileLinkResolverMemo.resolve;
}
```

In renderChatView set `const resolveFileLink = this.fileLinkResolver(state, session);` and bind `.resolveFileLink=${resolveFileLink}` on the actual chat-view opening tag, preserving all other bindings. The temporary `/` above is solely an ownership-check input, never a nonbrowser origin/base fallback; capture the actual base only after complete ownership is established.

- [ ] **Step 4: Rerun `npm test -- --run src/client/src/components/PiWebUiApp.fileLinks.test.ts src/client/src/components/ChatView.fileLinks.test.ts src/client/src/components/FormattedText.test.ts` and `npm run typecheck`.** Audit changed production browser paths with `rg -n 'fetch\(|WebSocket\(|XMLHttpRequest|/api|/pi-webui-plugins|href=|src=' src/client/src/transcriptFileLinks.ts src/client/src/api/urls.ts src/client/src/appUrl.ts src/client/src/components/FormattedText.ts src/client/src/components/ChatView.ts src/client/src/components/PiWebUiApp.ts`; classify every app-owned hit by its single URL boundary in the implementation report. External links/module-relative assets stay distinct by their actual semantics.
- [ ] **Step 5: Commit.**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.fileLinks.test.ts
git commit -m "feat(app): bind memoized session-owned file preview resolvers"
```

## Task 21: Publish canonical operator guidance and the exact minor Changeset

**Implementer tier:** Standard
**Lane:** docs-release
**Dependencies:** Task 4, Task 9, Task 15, Task 20

**Files:**

- Modify: `docs/config.md:14-53`, `docs/config.md:144-180`, `docs/config.md:204-245`
- Modify: `docs/config.html:95-104`, `docs/config.html:120-130`, `docs/config.html:183-200`, `docs/config.html:319-370`, `docs/config.html:594-650`
- Modify: `docs/machines.html:205-280`
- Create: `.changeset/local-file-link-preview.md`
- Test: `docs/config.md`, `docs/config.html`, `docs/machines.html`, `.changeset/local-file-link-preview.md` by the focused literal-content checks below; no permanent documentation-only test file

**Interfaces:**

- Consumes Task 2 `PiWebUiConfigValues.allowedOrigins?: string[]`, Task 3 global/selected-machine omission-preserves and explicit [] clears contracts, Task 4 preservation through existing drafts, and Tasks 6–9 independent startup guards/configured-machine Origin behavior.
- Consumes Task 14 read-only file-view route/status/header contract, Task 15 owning-machine federation, and Tasks 17–20 transcript links/images/workspace selection behavior.
- Produces synchronized `browser-origins` anchors, the exact configuration-matrix row below, selected-machine-safe-key inventory clarification, machine-header guidance linking `config#browser-origins`, and the exact approved minor Changeset. No public API or version mutation.

- [ ] **Step 1: Read the canonical neighboring sections and run this focused content check before edits.** These are implementation-time acceptance assertions, not claims that the current repository already documents the feature.

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const md = await readFile('docs/config.md', 'utf8');
const html = await readFile('docs/config.html', 'utf8');
const machines = await readFile('docs/machines.html', 'utf8');
assert(md.includes('| Extra trusted browser origins | `allowedOrigins` | — | Global (machine) | Not supported locally | Restart web/API and session daemon on that machine |'));
assert(md.includes('browser-origins')); assert(html.includes('id="browser-origins"'));
assert(machines.includes('config#browser-origins'));
for (const text of [md, html]) for (const phrase of ['allowedOrigins', '67,108,864', '64 MB', 'allowedHosts', 'Origin', 'DNS', 'pi-webui-sessiond.service']) assert(text.includes(phrase), phrase);
const fragment = await readFile('.changeset/local-file-link-preview.md', 'utf8');
assert.equal(fragment, '---\n"@hyperdreamer/pi-webui": minor\n---\n\nOpen local file links in session transcripts as read-only previews for HTML, SVG, PDF, images, and text, including files on remote machines.\n\nReject cross-origin browser actions and WebSocket connections, and add the machine-global `allowedOrigins` setting for reverse proxies that rewrite the public origin. Restart the web/API process and manually restart the session daemon after updating to activate the protection.\n');
console.log('PASS canonical file-view/origin documentation and exact minor Changeset');
NODE
```

Expected before edits: a missing row/anchor/fragment assertion, not a test-suite run. Do not add tests that merely mirror prose beyond these scoped content checks.

- [ ] **Step 2: Add the complete Markdown prose and matching semantic HTML.** Extend External path access with these paragraphs; place the origin section near gateway host/proxy guidance and add an explicit anchor in Markdown so both surfaces expose `browser-origins`.

````markdown
Transcript local-file links and Markdown images open a read-only preview served by the machine that owns the session. Workspace-relative reads stay inside that workspace. Absolute external paths require an allowed root on that machine; global and project-local external roots merge using the same policy as the Files panel.

Previews support HTML/SVG, PDF, raster images, and text/source files up to **64 MB (67,108,864 bytes)**. Unsupported files, nonregular filesystem entries, and directories are rejected; this view does not browse directories or write files. Self-contained HTML works, but sibling local images, scripts, and styles inside HTML do not resolve. Remote PDFs transfer whole, without range seeking.

HTML and SVG can animate under a restricted document policy with an opaque origin. Permitted remote scripts, styles, and images can still load. A document may navigate its own tab; the browser-origin checks described below protect PI WEBUI actions and socket upgrades after navigation.

<a id="browser-origins"></a>
### Browser origins

The optional machine-global `allowedOrigins` key trusts additional exact browser origins. Manage it in the global config file or config API; this feature adds no Settings editor for the list. It is unsupported in project-local `.pi-webui/config.json`, and it has no environment override. An apparent `PI_WEBUI_ALLOWED_ORIGINS` variable has no effect.

```json
{
  "allowedOrigins": ["https://pi.example", "https://pi.example:8443"]
}
```

Each entry must be an absolute HTTP or HTTPS origin with no credentials, path beyond an optional single root slash, query, fragment, wildcard, or origin list. Entries normalize scheme/host case and default ports: `HTTPS://PI.EXAMPLE:443/` becomes `https://pi.example`. Matching includes scheme, host, and effective port. Invalid values reject the entire field.

Omitting the file key or configuring `[]` grants no extra origins. Omission from either config update API preserves the current list; send an explicit `"allowedOrigins": []` to clear it. Both config and effectiveConfig responses show desired values, including a newly saved list, and do not prove that either running guard has activated them.

Browser POST, PUT, PATCH, DELETE, and all WebSocket upgrades are checked whenever Origin is present. Same-origin traffic and explicitly configured exact origins are accepted. `Origin: null`, malformed origins, and foreign origins are rejected with HTTP 403 before an action or socket attachment. Nonbrowser clients with no Origin continue to work. Safe GET/HEAD reads retain existing CORS behavior; this key grants no new cross-origin read access.

A reverse proxy that preserves Host and supplies the correct first X-Forwarded-Proto token needs no extra origin. If it rewrites Host, list the public scheme, authority, and nondefault port on the receiving machine. `allowedHosts` controls Vite development host admission and grants no browser-origin trust.

Installing the guard and changing `allowedOrigins` require restarting the web/API process and manually restarting `pi-webui-sessiond.service` on that machine. Ordinary UI/API autoreload does not restart the long-lived daemon. For this development setup, the daemon command is `systemctl --user restart pi-webui-sessiond.service`; the UI/API owner is `pi-webui-ui-dev.service`. Perform the restart when ready to activate the change.

DNS rebinding remains outside this protection: an attacker hostname whose Host and Origin agree can still match. Browser-origin matching does not implement host admission.
````

For config.html use a `<section class="doc-section" id="browser-origins">` with `<h2>Browser origins</h2>`, `<p>` for each corresponding paragraph, and `<pre><code class="language-json">` for the literal example. HTML-escape code text and render inline names in `<code>`; preserve all user-visible qualifications above. Add its in-page nav link. Add the restart item to both existing restart lists. Add `allowedOrigins` to both selected-machine-safe-key inventories, explicitly stating it is config/API-managed here while gateway host/port/allowedHosts stay gateway-owned. Insert the exact Markdown row:

```text
| Extra trusted browser origins | `allowedOrigins` | — | Global (machine) | Not supported locally | Restart web/API and session daemon on that machine |
```

And the equivalent HTML cells:

```html
<tr><td>Extra trusted browser origins</td><td><code>allowedOrigins</code></td><td>—</td><td>Global (machine)</td><td>Not supported locally</td><td>Restart web/API and session daemon on that machine</td></tr>
```

Add this machine guidance under existing header/trust material:

```html
<p>Default federation sends no browser Origin. A custom configured <code>Origin</code> equal to the remote machine's effective request origin works with an empty allowlist. A different valid configured Origin must appear in that remote machine's <code>allowedOrigins</code>; malformed and <code>null</code> origins are denied. Restart both the remote web/API process and session daemon after changing the list. See <a href="config#browser-origins">Browser origins</a>.</p>
<p>File previews use the session-owning machine's workspace and external-path policy. An offline remote keeps the gateway's existing machine error behavior.</p>
```

- [ ] **Step 3: Add the exact fragment.**

```md
---
"@hyperdreamer/pi-webui": minor
---

Open local file links in session transcripts as read-only previews for HTML, SVG, PDF, images, and text, including files on remote machines.

Reject cross-origin browser actions and WebSocket connections, and add the machine-global `allowedOrigins` setting for reverse proxies that rewrite the public origin. Restart the web/API process and manually restart the session daemon after updating to activate the protection.
```

- [ ] **Step 4: Rerun the Step 1 content check and `git diff --check`.** Inspect paired Markdown/HTML claims, nav anchors, config#browser-origins link, selected-machine inventory, exact fragment bytes, and README/CHANGELOG/version absence from the diff. No daemon restart or publication is performed.
- [ ] **Step 5: Commit.**

```bash
git add docs/config.md docs/config.html docs/machines.html .changeset/local-file-link-preview.md
git commit -m "docs: explain local file previews and browser-origin activation"
```

## Task 22: Add the executable browser audit and complete integrated verification

**Implementer tier:** Advanced
**Lane:** docs-release
**Dependencies:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12, Task 13, Task 14, Task 15, Task 16, Task 17, Task 18, Task 19, Task 20, Task 21

**Files:**

- Create: `scripts/verify-local-file-link-viewer.mjs`
- Test: `scripts/verify-local-file-link-viewer.mjs` through real Chromium, temporary fixtures, and private loopback app/mock only
- Test: all 23 specification section 10 test files using the literal focused command in Step 4

**Interfaces:**

- Consumes Tasks 6–9 production `buildApp(deps?: AppDependencies): Promise<FastifyInstance>` with startup `allowedOrigins?: string[]`, actual root guard, real WebSocket plugin, and before-handler rejection semantics.
- Consumes Tasks 11–15 real read-only GET `/api/projects/:projectId/workspaces/:workspaceId/file/view?path=<URLSearchParams value>` with opaque document CSP, exact count/no fixed length, existing ProjectService/WorkspaceService path ownership, and no guard/CSP bypass in production.
- Consumes Task 21 documentation/fragment and activation handoff; script affects only its own private onSend override and counting endpoints.
- Produces executable invocation `node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium <executable> --output-dir <audit-directory>`; both arguments required. Produces result.json with `passed`, `browserVersion`, `animationProgress`, per-attempt forbidden request/upgrade/handler counts, positive-control counts, navigation action/handshake statuses, exact weakened policies, script SHA-256/revision, and diagnostics. Failures/unavailable tooling exit nonzero.

- [ ] **Step 1: Establish the executable audit's failing boundary.** Run `node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium /usr/bin/chromium --output-dir /tmp/pi-webui-file-view-audit-initial`; expect missing script before creation. After the script exists, run it without arguments and with a nonexistent chromium path and require nonzero/unavailable, never passed:true. This audit replaces no section 10 Vitest case.
- [ ] **Step 2: Implement the private app/mock/CDP runner using the actual code below.** Keep helpers local. The runner must import the real buildApp/routes and create only temporary projects/config state; no production sessions, model requests, ptys, live credentials, or service restarts. Use installed ws, no new dependency. All counting routes, CSP overrides, and permissive mock CORS responses exist only in this script's private servers.

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp } from "../src/server/app.ts";
import { ProjectService } from "../src/server/projects/projectService.ts";
import { ProjectStore } from "../src/server/storage/projectStore.ts";
import { WorkspaceService } from "../src/server/workspaces/workspaceService.ts";
import { MachineService } from "../src/server/machines/machineService.ts";
import { MachineStore } from "../src/server/machines/machineStore.ts";
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const chromium = option("--chromium"); const output = option("--output-dir");
if (!chromium || !output || args.length !== 4) throw new Error("Required: --chromium <executable> --output-dir <audit-directory>");
await mkdir(output, { recursive: true });
const result = { passed: false, browserVersion: null, animationProgress: null, forbidden: {}, positiveControls: {}, navigation: {}, policies: {}, diagnostics: [] };
const scriptPath = fileURLToPath(import.meta.url);
result.scriptSha256 = createHash("sha256").update(await readFile(scriptPath)).digest("hex");
result.revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve(dirname(scriptPath), ".."), encoding: "utf8" }).trim();
await copyFile(scriptPath, join(output, "verify-local-file-link-viewer.mjs"));
const POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' http: https:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src http: https: data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'";
const policies = {
  original: POLICY,
  connect: POLICY.replace("connect-src 'none'", "connect-src http: https: ws: wss:"),
  formBlocked: POLICY.replace("sandbox allow-scripts", "sandbox allow-scripts allow-forms"),
  formAllowed: POLICY.replace("sandbox allow-scripts", "sandbox allow-scripts allow-forms").replace("form-action 'none'", "form-action http: https:"),
  frame: POLICY.replace("frame-src 'none'", "frame-src http: https:"),
  worker: POLICY.replace("sandbox allow-scripts; ", "").replace("worker-src 'none'", "worker-src 'self'"),
  object: POLICY.replace("sandbox allow-scripts; ", "").replace("object-src 'none'", "object-src http: https:").replace("frame-src 'none'", "frame-src http: https:"),
  base: POLICY.replace("base-uri 'none'", "base-uri http: https:"),
  unsandboxed: POLICY.replace("sandbox allow-scripts; ", ""),
};
result.policies = policies;
class Cdp {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.on("message", (data) => { const message = JSON.parse(String(data)); const request = this.pending.get(message.id); if (!request) return; this.pending.delete(message.id); clearTimeout(request.timer); if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result); });
    socket.on("close", () => { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP closed")); } this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP deadline: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(sessionId, expression) {
    const value = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value;
  }
}
const counts = new Map(); const upgrades = new Map(); const protectedCounts = { action: 0, socket: 0, worker: 0, bridge: 0 }; const statuses = [];
const requestNames = ["/fetch", "/xhr", "/eventsource", "/beacon", "/form", "/frame", "/object", "/base-probe", "/executed-frame", "/executed-object", "/executed-worker", "/resource-image", "/resource-script", "/resource-style", "/executed-script"];
const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const snapshot = () => ({ requests: Object.fromEntries(requestNames.map((name) => [name, counts.get(name) ?? 0])), upgrades: { "/ws": upgrades.get("/ws") ?? 0 }, handlers: { ...protectedCounts } });
const clearCounts = () => { counts.clear(); upgrades.clear(); protectedCounts.action = 0; protectedCounts.socket = 0; protectedCounts.worker = 0; protectedCounts.bridge = 0; statuses.length = 0; };
const acceptedSockets = new Set();
const trackSocket = (socket) => { acceptedSockets.add(socket); socket.once("close", () => acceptedSockets.delete(socket)); socket.on("error", () => undefined); };
async function until(condition, label, duration = 6000) { const deadline = performance.now() + duration; while (!condition()) { assert(performance.now() < deadline, label); await delay(10); } }
function onceBounded(emitter, event, label, duration = 6000) {
  return new Promise((resolveEvent, reject) => {
    const cleanup = () => { clearTimeout(timer); emitter.removeListener(event, complete); emitter.removeListener("error", failed); };
    const complete = (...values) => { cleanup(); resolveEvent(values); }; const failed = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(label)); }, duration);
    emitter.once(event, complete); emitter.once("error", failed);
  });
}
function rawHandshake(url, origin) {
  return new Promise((resolveHandshake, reject) => {
    const socket = new WebSocket(url, { headers: { origin } }); trackSocket(socket); let settled = false;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Audit handshake deadline")); }, 6000);
    const complete = (status, body) => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); resolveHandshake({ status, body }); };
    socket.once("message", () => complete(101, ""));
    socket.once("unexpected-response", (_request, response) => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.once("end", () => complete(response.statusCode, Buffer.concat(chunks).toString())); });
    socket.on("error", error => { if (!settled) { clearTimeout(timer); reject(error); } });
  });
}
let app; let mock; let mockSockets; let browser; let cdpSocket; let root; let appUrl; let mockUrl; let spawnError;
async function stopBrowser() {
  if (!browser || browser.exitCode !== null) return;
  const exited = once(browser, "exit").catch(() => undefined); browser.kill("SIGTERM");
  await Promise.race([exited, delay(1000)]); if (browser.exitCode === null) { browser.kill("SIGKILL"); await until(() => browser.exitCode !== null || browser.signalCode !== null, "Chromium was not reaped", 2000); }
}
function fixtureHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Private file view audit</title><div id="animation">animation</div><script>
  const app = ${JSON.stringify(appUrl)}, mock = ${JSON.stringify(mockUrl)};
  const mode = new URL(location.href).searchParams.get('probe') || 'all';
  window.animationFrames = 0; function frame() { window.animationFrames++; document.querySelector('#animation').style.transform = 'translateX(' + window.animationFrames + 'px)'; requestAnimationFrame(frame); } requestAnimationFrame(frame);
  window.originEvidence = { origin: self.origin, storage: false }; try { localStorage.setItem('private-audit','yes'); window.originEvidence.storage = true; localStorage.removeItem('private-audit'); } catch {}
  window.violations = []; document.addEventListener('securitypolicyviolation', e => window.violations.push(e.violatedDirective));
  const tasks = []; const selected = name => mode === 'all' || mode === name;
  if (selected('connect')) {
    tasks.push(fetch(mock + '/fetch', { mode: 'no-cors' }).catch(() => undefined));
    tasks.push(new Promise(resolve => { const x = new XMLHttpRequest(); x.onloadend = resolve; x.onerror = resolve; x.open('GET', mock + '/xhr'); x.send(); }));
    tasks.push(new Promise(resolve => { const s = new WebSocket(mock.replace('http:', 'ws:') + '/ws'); s.onopen = () => { s.close(); resolve(); }; s.onerror = resolve; }));
    tasks.push(new Promise(resolve => { const e = new EventSource(mock + '/eventsource'); e.onopen = () => { e.close(); resolve(); }; e.onerror = () => { e.close(); resolve(); }; }));
    navigator.sendBeacon(mock + '/beacon', 'audit');
  }
  if (selected('frame')) { const iframe = document.createElement('iframe'); iframe.src = mock + '/frame'; document.body.append(iframe); }
  if (selected('worker')) { try { const worker = new Worker(app + '/api/audit/worker'); tasks.push(new Promise(resolve => { worker.onmessage = () => { worker.terminate(); resolve(); }; worker.onerror = () => { worker.terminate(); resolve(); }; })); } catch {} }
  if (selected('object')) { const object = document.createElement('object'); object.type = 'text/html'; object.data = mock + '/object'; document.body.append(object); }
  if (selected('base')) { const base = document.createElement('base'); base.href = mock + '/'; document.head.append(base); const image = new Image(); image.src = 'base-probe'; document.body.append(image); }
  const remoteImage = new Image(); remoteImage.src = mock + '/resource-image'; document.body.append(remoteImage);
  const remoteScript = document.createElement('script'); remoteScript.src = mock + '/resource-script'; document.head.append(remoteScript);
  const remoteStyle = document.createElement('link'); remoteStyle.rel = 'stylesheet'; remoteStyle.href = mock + '/resource-style'; document.head.append(remoteStyle);
  if (selected('form')) { const f = document.createElement('form'); f.method = 'POST'; f.action = mock + '/form'; document.body.append(f); window.submitAuditForm = () => { window.formAttempted = true; f.submit(); }; }
  window.auditStarted = true;
  Promise.allSettled(tasks).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).then(() => window.auditDone = true);
  </script>`;
}
async function waitFor(cdp, sessionId, expression) {
  return cdp.evaluate(sessionId, `(async () => { const deadline = performance.now() + 6000; while (!(${expression})) { if (performance.now() > deadline) throw new Error('Page condition deadline'); await new Promise(r => requestAnimationFrame(r)); } return true; })()`);
}
try {
  await access(chromium, constants.X_OK);
  root = await mkdtemp(join(tmpdir(), "pi-file-view-audit-")); const workspacePath = join(root, "workspace"); await mkdir(workspacePath);
  const projects = new ProjectService(new ProjectStore(join(root, "projects.json"))); const project = await projects.add({ path: workspacePath }); const workspaces = new WorkspaceService(); const [workspace] = await workspaces.list(project); assert(workspace);
  const response = () => ({ path: join(root, "config.json"), exists: true, config: {}, effectiveConfig: {}, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false, sessiondUrl: false } });
  app = await buildApp({ projects, workspaces, machines: new MachineService(new MachineStore(join(root, "machines.json"))), config: { read: response, write: response, update: response }, sessionDaemon: { request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' }), connectWebSocket: () => { throw new Error('Unexpected daemon bridge'); } }, hostSpeech: { status: async () => ({ available: false, voices: [] }), speak: async (r) => ({ runId: r.runId, outcome: 'ended' }), stop: async () => undefined, close: async () => undefined }, logger: false, clientDist: false });
  app.addHook("onSend", async (request, reply, payload) => { const policy = new URL(request.url, "http://private.invalid").searchParams.get("auditPolicy"); if (policy && Object.hasOwn(policies, policy) && request.url.includes("/file/view?")) reply.header("Content-Security-Policy", policies[policy]); return payload; });
  app.addHook("onResponse", async (request, reply) => { if (["/api/audit/action", "/api/audit/socket", "/api/audit/control"].some(path => request.url.startsWith(path))) statuses.push({ path: request.url, status: reply.statusCode, origin: request.headers.origin, upgrade: request.headers.upgrade ?? null }); });
  app.post("/api/audit/action", () => { protectedCounts.action++; return { ok: true }; });
  app.get("/api/audit/socket", { websocket: true }, (socket) => { trackSocket(socket); protectedCounts.socket++; socket.send("ready"); });
  app.get("/api/audit/worker", (_request, reply) => { protectedCounts.worker++; return reply.type("application/javascript").send(`fetch(${JSON.stringify("WORKER_MARKER")}, {mode:'no-cors'}).then(() => postMessage('done')).catch(() => postMessage('failed'));` .replace(JSON.stringify("WORKER_MARKER"), JSON.stringify(mockUrl + "/executed-worker"))); });
  app.get("/api/audit/control", (_r, reply) => reply.type("text/html").send("<!doctype html><title>same-origin control</title>"));
  appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  mock = http.createServer((request, response) => {
    const path = new URL(request.url, "http://private.invalid").pathname; increment(counts, path);
    response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Cache-Control", "no-store");
    if (path === "/eventsource") { response.setHeader("Content-Type", "text/event-stream"); response.end("data: ready\n\n"); }
    else if (path === "/frame" || path === "/object") { response.setHeader("Content-Type", "text/html"); response.end(`<script>fetch('/executed-${path.slice(1)}',{mode:'no-cors'})<\/script>`); }
    else if (path === "/foreign") { response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><script>fetch(${JSON.stringify(appUrl + "/api/audit/action")},{method:'POST',mode:'no-cors',body:'audit'});const s=new WebSocket(${JSON.stringify(appUrl.replace("http:", "ws:") + "/api/audit/socket")});s.onerror=()=>{window.socketFailed=true};window.foreignStarted=true;<\/script>`); }
    else if (path === "/resource-script") { response.setHeader("Content-Type", "application/javascript"); response.end(`new Image().src=${JSON.stringify(mockUrl + "/executed-script")}`); }
    else if (path === "/resource-style") { response.setHeader("Content-Type", "text/css"); response.end("#animation { color: rgb(1, 2, 3); }"); }
    else { response.setHeader("Content-Type", "text/plain"); response.end("ok"); }
  });
  mockSockets = new WebSocketServer({ noServer: true }); mock.on("upgrade", (request, socket, head) => { increment(upgrades, new URL(request.url, "http://private.invalid").pathname); mockSockets.handleUpgrade(request, socket, head, (websocket) => { trackSocket(websocket); websocket.send("ready"); }); });
  await new Promise((done) => mock.listen(0, "127.0.0.1", done)); mockUrl = `http://127.0.0.1:${mock.address().port}`;
  await writeFile(join(workspacePath, "audit.html"), fixtureHtml());
  const profile = join(root, "chromium"); await mkdir(profile); const stderr = [];
  browser = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] }); browser.stderr.on("data", (data) => stderr.push(String(data))); browser.on("error", (error) => { spawnError = error; result.diagnostics.push(String(error)); });
  const activePort = join(profile, "DevToolsActivePort"); let portText;
  for (let i = 0; i < 250; i++) { try { portText = await readFile(activePort, "utf8"); break; } catch { if (spawnError) throw spawnError; if (browser.exitCode !== null) throw new Error(`Chromium exited: ${stderr.join("")}`); await delay(20); } }
  assert(portText, "Chromium debugging endpoint unavailable"); const [port, endpoint] = portText.trim().split("\n");
  cdpSocket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`); await onceBounded(cdpSocket, "open", "CDP connection deadline"); const cdp = new Cdp(cdpSocket);
  result.browserVersion = await cdp.send("Browser.getVersion"); const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }); const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }); await cdp.send("Page.enable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId);
  const route = `${appUrl}/api/projects/${encodeURIComponent(project.id)}/workspaces/${encodeURIComponent(workspace.id)}/file/view`;
  const viewUrl = (policy, probe = "all") => `${route}?${new URLSearchParams({ path: "audit.html", auditPolicy: policy, probe })}`;
  const headers = await fetch(viewUrl("original")); assert.equal(headers.status, 200); assert.equal(headers.headers.get("content-security-policy"), POLICY); assert.equal(headers.headers.get("content-length"), null); assert.equal(headers.headers.get("referrer-policy"), "no-referrer"); result.headers = Object.fromEntries(headers.headers); await headers.arrayBuffer();
  const navigate = async (url) => { await cdp.send("Page.navigate", { url }, sessionId); await waitFor(cdp, sessionId, `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`); };
  const run = async (policy, probe) => {
    clearCounts(); await navigate(viewUrl(policy, probe)); await waitFor(cdp, sessionId, "window.auditDone === true");
    if (probe === "all") { await cdp.evaluate(sessionId, "window.submitAuditForm()"); await cdp.evaluate(sessionId, "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))"); assert.equal(await cdp.evaluate(sessionId, "window.formAttempted"), true); }
    if (policy === "connect") await until(() => ["/fetch", "/xhr", "/eventsource", "/beacon"].every(name => (counts.get(name) ?? 0) > 0) && (upgrades.get("/ws") ?? 0) > 0, "Connect positive controls incomplete");
    if (probe === "frame" || probe === "object") await until(() => (counts.get(`/executed-${probe}`) ?? 0) > 0, `${probe} execution marker missing`);
    if (probe === "base") await until(() => (counts.get("/base-probe") ?? 0) > 0, "Base control did not change resource resolution");
    if (probe === "form") { await cdp.evaluate(sessionId, "window.submitAuditForm()"); await waitFor(cdp, sessionId, "window.violations.includes('form-action')"); }
    await until(() => ["/resource-image", "/resource-script", "/resource-style", "/executed-script"].every(name => (counts.get(name) ?? 0) > 0), "Allowed remote resource controls missing");
    return snapshot();
  };
  result.forbidden = await run("original", "all");
  const frames = await cdp.evaluate(sessionId, "(async () => { const a = window.animationFrames; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return [a,window.animationFrames]; })()"); assert(frames[1] > frames[0]); result.animationProgress = frames;
  const opaque = await cdp.evaluate(sessionId, "window.originEvidence"); assert.equal(opaque.origin, "null"); assert.equal(opaque.storage, false); result.opaqueOrigin = opaque;
  for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon", "/form", "/frame", "/object", "/base-probe", "/executed-frame", "/executed-object", "/executed-worker"]) assert.equal(result.forbidden.requests[path] ?? 0, 0, path);
  assert.equal(result.forbidden.upgrades["/ws"] ?? 0, 0); assert.equal(result.forbidden.handlers.worker, 0); assert((result.forbidden.requests["/resource-image"] ?? 0) > 0);
  for (const [policy, probe] of [["connect", "connect"], ["frame", "frame"], ["worker", "worker"], ["object", "object"], ["base", "base"], ["unsandboxed", "connect"]]) {
    const control = await run(policy, probe); result.positiveControls[policy] = control;
    if (policy === "connect") { for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon"]) assert((control.requests[path] ?? 0) > 0, path); assert((control.upgrades["/ws"] ?? 0) > 0); }
    if (policy === "frame" || policy === "object") { await waitFor(cdp, sessionId, "document.readyState === 'complete'"); await new Promise((done) => setImmediate(done)); assert((counts.get(`/executed-${policy}`) ?? 0) > 0); }
    if (policy === "worker") { assert(control.handlers.worker > 0); assert((control.requests["/executed-worker"] ?? 0) > 0); }
    if (policy === "base") assert((control.requests["/base-probe"] ?? 0) > 0);
    if (policy === "unsandboxed") { const origin = await cdp.evaluate(sessionId, "window.originEvidence"); assert.equal(origin.origin, appUrl); assert.equal(origin.storage, true); for (const path of ["/fetch", "/xhr", "/eventsource", "/beacon"]) assert.equal(control.requests[path] ?? 0, 0); }
  }
  result.positiveControls.formBlocked = await run("formBlocked", "form"); assert.equal(counts.get("/form") ?? 0, 0);
  clearCounts(); await navigate(viewUrl("formAllowed", "form")); await waitFor(cdp, sessionId, "window.auditDone === true"); await cdp.evaluate(sessionId, "window.submitAuditForm()");
  await until(() => (counts.get("/form") ?? 0) > 0, "Form control did not reach mock");
  result.positiveControls.formAllowed = snapshot();
  clearCounts(); await navigate(viewUrl("original", "connect")); await waitFor(cdp, sessionId, "window.auditDone === true");
  await cdp.evaluate(sessionId, `location.href = ${JSON.stringify(mockUrl + "/foreign")}`);
  const navDeadline = Date.now() + 6000; while (statuses.filter((s) => s.status === 403).length < 2) { assert(Date.now() < navDeadline, "Navigation guard observations missing"); await delay(10); }
  assert.equal(await cdp.evaluate(sessionId, "location.origin"), mockUrl); assert.equal(protectedCounts.action, 0); assert.equal(protectedCounts.socket, 0); result.navigation = { statuses: [...statuses], handlers: { ...protectedCounts } }; assert(statuses.some((s) => s.path === "/api/audit/action" && s.status === 403)); assert(statuses.some((s) => s.path === "/api/audit/socket" && s.status === 403));
  const browserNavigation = { statuses: [...statuses], handlers: { ...protectedCounts } }; assert(statuses.some(s => s.path === "/api/audit/socket" && s.upgrade === "websocket" && s.origin === mockUrl && s.status === 403));
  const rejectedPost = await fetch(appUrl + "/api/audit/action", { method: "POST", headers: { origin: mockUrl }, body: "observer" });
  assert.equal(rejectedPost.status, 403); assert.equal(await rejectedPost.text(), '{"error":"Cross-origin request rejected"}');
  const rejectedSocket = await rawHandshake(appUrl.replace("http:", "ws:") + "/api/audit/socket", mockUrl); assert.deepEqual(rejectedSocket, { status: 403, body: '{"error":"Cross-origin request rejected"}' });
  const safeRead = await cdp.evaluate(sessionId, `fetch(${JSON.stringify(appUrl + "/api/audit/control")}).then(() => 'readable').catch(() => 'cors-blocked')`); assert.equal(safeRead, "cors-blocked");
  assert(statuses.some(s => s.path === "/api/audit/control" && s.origin === mockUrl && s.status === 200));
  result.navigation = { ...browserNavigation, rejectedPost: { status: 403, body: '{"error":"Cross-origin request rejected"}' }, rejectedSocket, foreignSafeGet: { serverStatus: 200, browserRead: safeRead }, bridgeCalls: protectedCounts.bridge };
  assert.equal(protectedCounts.action, 0); assert.equal(protectedCounts.socket, 0); assert.equal(protectedCounts.bridge, 0);
  clearCounts(); await navigate(appUrl + "/api/audit/control");
  const positive = await cdp.evaluate(sessionId, `(async () => { const action = await fetch('/api/audit/action', {method:'POST',body:'control'}); const socket = await new Promise((resolve,reject) => { const s = new WebSocket(${JSON.stringify(appUrl.replace("http:", "ws:") + "/api/audit/socket")}); s.onmessage=()=>{s.close();resolve(101)};s.onerror=reject; }); return {action:action.status,socket}; })()`);
  assert.deepEqual(positive, { action: 200, socket: 101 }); assert.equal(protectedCounts.action, 1); assert.equal(protectedCounts.socket, 1); result.positiveControls.guard = { ...positive, handlers: { ...protectedCounts } };
  result.passed = true;
} catch (error) { result.diagnostics.push(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
finally {
  try {
    cdpSocket?.terminate(); for (const socket of acceptedSockets) socket.terminate(); await stopBrowser();
    if (mockSockets) await new Promise(done => mockSockets.close(done));
    if (mock) { mock.closeAllConnections(); await new Promise((done) => mock.close(done)); }
    if (app) await app.close(); if (root) await rm(root, { recursive: true, force: true });
  } catch (error) { result.passed = false; process.exitCode = 1; result.diagnostics.push(`Cleanup failed: ${String(error)}`); }
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 3: Run every private positive control and inspect the audit's complete evidence.** The script already waits for frame/object/base execution markers before freezing each snapshot, records explicit zero-valued forbidden request names, bounds browser startup/CDP/handshakes, and tracks accepted sockets for teardown. Verify server-side browser POST and pre-upgrade rejection observations plus the independent raw observer's exact 403 JSON, zero 101/handler/bridge counters, and positive 200/101 controls. Its foreign safe GET records server 200 and failed browser CORS read separately. Remote script/style/image requests and the executed script marker are required allowed-resource controls. Both form responses retain `sandbox allow-scripts allow-forms`; their single difference is form-action none versus http/https. Worker/object positive controls record their removed sandbox and changed worker/object/frame directives. The unsandboxed control retains connect-src none, proves origin/storage difference, and requires zero API counts. Any absent positive control, missing browser, missing ws, or incomplete child teardown is nonzero with passed:false.

Run this exact interface on the integration host, using a fresh audit directory outside the worktree, and archive stdout JSON, browserVersion, the copied script, its SHA-256/revision, and diagnostics. Use `node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium /usr/bin/chromium --output-dir /tmp/pi-webui-local-file-link-viewer-audit`. A rerun uses a fresh suffixed directory so evidence is not overwritten. Do not weaken production CSP/guards to make it pass.

- [ ] **Step 4: Complete integrated verification sequentially and record exact results.**

```bash
npm test -- --run src/shared/fileViewTypes.test.ts src/shared/browserOrigins.test.ts src/client/src/transcriptFileLinks.test.ts src/client/src/formatting/markdown.test.ts src/client/src/api/urls.test.ts src/server/workspaces/fileViewService.test.ts src/server/http/fileViewReply.test.ts src/server/workspaceExplorerRoutes.test.ts src/shared/federatedRoutes.test.ts src/server/app.remoteProxy.test.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.fileLinks.test.ts src/client/src/components/PiWebUiApp.fileLinks.test.ts src/server/http/browserOriginGuard.test.ts src/server/app.originGuard.test.ts src/server/sessiond/sessionDaemonApp.originGuard.test.ts src/config.test.ts src/server/configRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/server/workspaces/projectPiWebUiConfig.test.ts src/server/machines/machineClient.test.ts src/server/workspaces/pathAccessPolicy.test.ts
npm run typecheck
npx eslint src/shared/fileViewTypes.ts src/shared/browserOrigins.ts src/shared/apiTypes.ts src/config.ts src/server/configRoutes.ts src/client/src/api/parsers.ts src/client/src/components/settings/settingsConfigDraft.ts src/client/src/appUrl.ts src/client/src/api/urls.ts src/client/src/formatting/markdown.ts src/client/src/transcriptFileLinks.ts src/client/src/components/FormattedText.ts src/client/src/components/ChatView.ts src/client/src/components/PiWebUiApp.ts src/server/workspaceExplorerRoutes.ts src/shared/federatedRoutes.ts src/server/machines/machineProxyRoutes.ts src/server/app.ts src/server/workspaces/pathAccessPolicy.ts src/server/workspaces/fileViewService.ts src/server/http/fileViewReply.ts src/server/http/browserOriginGuard.ts src/server/sessiond/sessionDaemonApp.ts src/server/sessiond.ts src/shared/fileViewTypes.test.ts src/shared/browserOrigins.test.ts src/client/src/transcriptFileLinks.test.ts src/client/src/formatting/markdown.test.ts src/client/src/api/urls.test.ts src/server/workspaces/fileViewService.test.ts src/server/http/fileViewReply.test.ts src/server/workspaceExplorerRoutes.test.ts src/shared/federatedRoutes.test.ts src/server/app.remoteProxy.test.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.fileLinks.test.ts src/client/src/components/PiWebUiApp.fileLinks.test.ts src/server/http/browserOriginGuard.test.ts src/server/app.originGuard.test.ts src/server/sessiond/sessionDaemonApp.originGuard.test.ts src/config.test.ts src/server/configRoutes.test.ts src/client/src/api/parsers.test.ts src/client/src/components/settings/settingsConfigDraft.test.ts src/server/workspaces/projectPiWebUiConfig.test.ts src/server/machines/machineClient.test.ts src/server/workspaces/pathAccessPolicy.test.ts scripts/verify-local-file-link-viewer.mjs
npm run verify:fast
git diff --check
node --import tsx scripts/verify-local-file-link-viewer.mjs --chromium /usr/bin/chromium --output-dir /tmp/pi-webui-local-file-link-viewer-audit-final
```

Run no concurrent full suite. A later final merge/release gate uses `npm run verify`, serial and alone; publication stays outside this plan. Review final diff against the approved spec: original transcript/cache unchanged, same Files authorization, read-only route, handle/stream cleanup, exact CSP, two startup guard installations, no browser Origin/Range forwarding, no README/CHANGELOG/version mutations, one minor fragment. Implementation handoff must link the external audit result.json and exact script revision/hash, test/mutation evidence and any native unavailable controls, and quote the manual daemon-restart note from Global Constraints. Do not restart the services.

- [ ] **Step 5: Commit.**

```bash
git add scripts/verify-local-file-link-viewer.mjs
git commit -m "test(browser): audit file preview policy and navigation origin protection"
```
