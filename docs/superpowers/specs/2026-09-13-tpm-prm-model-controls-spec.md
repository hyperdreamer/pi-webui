# Technical Specification: Per-Model TPM and RPM Controls

**Date:** 2026-09-13
**Status:** Approved by the user on 2026-09-13; amended on 2026-09-14 to name the requests-per-minute field RPM. The frontier specification review passed with no blocking findings and its nonblocking recommendations are incorporated in this document.
**Related Design Document:** `docs/superpowers/specs/2026-09-13-tpm-rpm-model-controls-design.md` (approved at commit `be84b8b7801d1bc5a30304a32aae92711a30e5f1`)
**Target Package:** `@hyperdreamer/pi-webui`
**Change Class:** user-visible feature (minor)
**Operation Class:** session-daemon runtime ownership change; installation requires one manual `pi-webui-sessiond.service` restart

---

## 1. Status and Scope

### 1.1 Purpose

This specification defines the exact implementation contract for optional per-model
TPM and RPM controls in PI WEBUI. It preserves every approved product decision in the
design document:

- independent budgets keyed by exact provider name plus exact model ID;
- `tpm` and `rpm` stored directly on `providers[provider].models[]` entries;
- TPM charged from actual terminal token usage
  (`input + output + cacheRead + cacheWrite`);
- RPM counted per underlying model-call dispatch;
- a rolling 60-second window, never calendar-minute buckets;
- FIFO admission per model; originating cancellation preserved; existing caller
  deadlines preserved;
- omission or `0` independently disables a dimension;
- one shared daemon-owned limiter owner, not one shared cross-model budget;
- the existing **Models settings > Model configuration** dialog gains a visible,
  unframed **Rate limits** section below Context/Max output tokens and above Cost,
  edited and persisted by the existing **Save** action;
- no manual JSON editing is required for the supported workflow;
- unknown document/provider/model fields survive read, edit, save, and Pi loading;
- Pi 0.85.1 compatibility without patching installed Pi, forking the SDK, or changing
  provider request payloads;
- no global, provider-wide, tier, API-key-pool, distributed, persistent, or adaptive
  limits.

### 1.2 Resolved Ambiguities

These decisions resolve the open points left by the design; each is binding.

1. **JSONC dialect.** Pi 0.85.1 accepts an optional leading BOM, `//` line comments,
   and trailing commas. It does **not** accept `/* */` block comments
   (`dist/utils/json.js` in the installed package strips only `//` line comments).
   The design text names "line/block comments", but accepting block comments would
   let the GUI read and re-save a file that Pi rejects. The parser therefore matches
   Pi 0.85.1 exactly and block comments produce `MODELS_CONFIG_PARSE_FAILED`.
2. **Parser choice.** A small vendored parser reproduces Pi 0.85.1's accepted
   language. No new runtime dependency is added. Parity is proven by tests that run
   the same fixtures through the installed Pi runtime.
3. **Limits-invalid versus parse-failed.** A syntactically valid document with an
   invalid `tpm`/`rpm` remains readable and editable through the dialog so the user
   can repair it; its limits snapshot is rejected and never activated as unlimited.
   A document that fails parsing is not rendered as an empty document and cannot be
   saved until it is fixed externally and reloaded.
4. **Read response shape.** `GET /models-config` keeps returning the bare document
   so existing clients and remote daemons remain safe in both version directions. A
   new sidecar endpoint reports active limiter status; the new client validates
   `tpm`/`rpm` values itself with the shared pure validator.
5. **No capability flag.** The dialog detects limiter support by the sidecar
   endpoint's success or 404; no entry is added to `PI_WEBUI_CAPABILITIES` or
   `FEDERATED_HTTP_ROUTES` capability requirements.
6. **Save guard.** `PUT /models-config` re-reads the on-disk file and refuses the
   save with `MODELS_CONFIG_UNREADABLE` while that file fails to parse. This
   protects a malformed file even from an older client that falls back to an empty
   document.
7. **Accepted snapshot recovery.** After an external fix, clicking **Reload** in the
   dialog reads the repaired document; clicking **Save** re-persists it, publishes
   limits, and wakes waiters. Reload itself never publishes.
8. **No cross-file transaction.** If persistence succeeds but the runtime refresh
   validation fails, the file and live state differ until a successful save or a
   daemon restart; the save reports failure with `persisted: true`.
9. **DOM tests and layout evidence.** Existing client tests use the
   `@vitest-environment jsdom` docblock; the Rate limits behavior tests use that
   same existing environment with real DOM events and `await element.updateComplete`.
   jsdom cannot calculate layout, so field placement, overflow, and keyboard-focus
   geometry remain a Chromium CDP verification (Section 11.4). Template inspection
   is used only to assert content presence and must never be presented as layout or
   accessibility coverage.

### 1.3 Scope

- Add optional `tpm`/`rpm` fields on explicit `models[]` entries in the active
  profile's `models.json`.
- Add a daemon-owned rolling-window admission and accounting owner shared by every
  model call surface the design lists.
- Add the Rate limits section to the existing dialog with draft, validation, Save,
  and error behavior.
- Add structured API/status/error responses and the sidecar status route.
- Add documentation and a Changeset.

### 1.4 Non-Goals (Out of Scope)

- Global, provider-wide, tier-level, or API-key-pool limits.
- Distributed or cross-process coordination; separate machines, separate daemons,
  standalone Pi CLI instances, and external applications do not share budgets.
- Persistent usage history, billing integration, provider quota discovery, adaptive
  429 handling, or a live usage dashboard, countdown, or new session-status
  protocol.
- Reinterpreting TPM as a request-size limit, output cap, or reservation of
  `maxTokens`.
- A second limits syntax under `modelOverrides`, synthesized catalog entries, or any
  change to Pi's built-in/custom-model merge rules.
- A `models.json` file watcher. External file edits require a daemon restart to
  guarantee limit reload.
- Forking, subclassing, or broadly monkey-patching `ModelRuntime`; editing installed
  Pi; injecting fields into provider request payloads.
- Charging model discovery, catalog refresh, authentication, transcription/speech
  transport, or deferred-result retrieval/cancellation.
- Extensions that call external SDKs directly or replace/bypass PI WEBUI's
  model-call interfaces.
- Adding a new DOM test dependency or vitest environment (the existing
  `@vitest-environment jsdom` environment is used);
- Changing provider API, authentication configuration, reasoning, context/output
  limits, compatibility settings, or catalog resolution.

---

## 2. Goals and Non-Goals (Implementation View)

### 2.1 Goals

1. **Exact shared identity.** Every call to the same provider and model ID in one
   daemon consumes the same budget, across interactive prompts, tool continuations,
   follow-ups, steering, spawned sessions, compaction, branch summaries, naming, PI
   WEBUI utility fallback, speech polishing, and connection checks.
2. **Independent dimensions.** `tpm` and `rpm` are independently enabled, disabled,
   changed, and accounted.
3. **Correct rolling window.** Timestamps are taken from a monotonic clock; an entry
   expires exactly 60,000 ms after its timestamp; admission uses strict `<` against
   the retained sums.
4. **Safe waiting.** Calls never spend a RPM unit, allocate a response stream, or
   invoke a delegate while waiting. Cancellation and shutdown remove waiters and
   timers without leaks.
5. **One-time accounting.** Terminal usage is recorded exactly once per dispatched
   call, before the terminal event or result is forwarded, and is never invented,
   negated, or duplicated.
6. **Predictable configuration lifecycle.** Persist, refresh-validate, publish,
   wake. Failures never silently activate unlimited budgets and never overwrite a
   newer accepted configuration.
7. **Usable GUI.** Users can set, change, and clear limits inside the existing
   dialog, see saved values after reopening, and cannot accidentally save an invalid
   rate-limit draft or an empty replacement for an unreadable file.

### 2.2 Non-Goals

- Hard token ceilings. Actual-usage accounting permits overshoot by design.
- Coordination with provider-side quotas or other PI WEBUI processes.
- Zero-wait behavior when limits are exhausted.
- Editing limits for models absent from `models[]`.
- Preserving JSON formatting or comments on save; the serializer normalizes.
- A daemon-wide pause, global kill switch, or per-session override.

---

## 3. Data Contracts

### 3.1 Configuration Document

`tpm` and `rpm` are optional, non-negative safe integers stored directly on entries
of `providers[provider].models[]`:

```json
{
  "providers": {
    "example-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$EXAMPLE_API_KEY",
      "models": [
        { "id": "model-large", "tpm": 100000, "rpm": 60 },
        { "id": "model-small", "tpm": 300000, "rpm": 120 }
      ]
    }
  }
}
```

Rules:

1. Each field accepts a non-negative safe integer. Reject strings, booleans, `null`,
   negative values, fractions, non-finite numbers, and values outside
   `Number.MAX_SAFE_INTEGER`.
2. Blank UI input removes the field. An explicit `0` is valid and disables that
   dimension.
3. No limit inherits from the document root, a provider, `modelOverrides`, another
   model, or another provider.
4. Root-level and provider-level `tpm`/`rpm` fields remain opaque. They are
   preserved byte-for-byte through the value round trip and never activate a limit.
5. `modelOverrides` entries may carry unknown `tpm`/`rpm` fields; they remain opaque
   and never activate a limit.
6. Unrecognized document, provider, and model fields survive parsing, editing, and
   saving. `models.json` is written back with the existing
   `JSON.stringify(document, null, 2)` plus a trailing newline.
7. This feature recognizes limits only on explicit `models[]` entries. Models absent
   from those entries are unlimited. Adding a custom entry that matches a built-in
   model continues to replace that built-in definition under Pi's existing rules;
   the dialog must not silently create such a replacement as a side effect of rate
   limit editing.

### 3.2 Shared Value Types

New file `src/shared/modelRateLimits.ts` owns the dialect-independent value contract
used by both server and client. It has no Node or browser dependencies.

```ts
export const MODEL_RATE_LIMIT_FIELDS = ["tpm", "rpm"] as const;
export type ModelRateLimitField = (typeof MODEL_RATE_LIMIT_FIELDS)[number];

export const MODEL_RATE_LIMIT_WINDOW_MS = 60_000;

export type ModelRateLimitInvalidReason =
  | "not-a-number"
  | "not-finite"
  | "not-an-integer"
  | "negative"
  | "unsafe-integer"
  | "missing-model-id";

export type ModelRateLimitInvalidFieldReason = Exclude<
  ModelRateLimitInvalidReason,
  "missing-model-id"
>;

export interface ModelRateLimitValues {
  tpm?: number;
  rpm?: number;
}

export type ModelRateLimitFieldParse =
  | { ok: true; value: number | undefined }
  | { ok: false; reason: ModelRateLimitInvalidFieldReason };

export function parseModelRateLimitStoredValue(value: unknown): ModelRateLimitFieldParse;
export function parseModelRateLimitDraftText(text: string): ModelRateLimitFieldParse;
export function modelRateLimitValuesFromEntry(
  entry: Record<string, unknown>,
): { ok: true; values: ModelRateLimitValues } | { ok: false; field: ModelRateLimitField; reason: ModelRateLimitInvalidFieldReason };
export function modelRateLimitFieldMessage(
  field: ModelRateLimitField,
  reason: ModelRateLimitInvalidReason,
): string;
export function sumModelTerminalTokens(usage: unknown): number;
```

`parseModelRateLimitStoredValue`:

1. `undefined` means the field is omitted and returns `{ ok: true, value: undefined }`
   (disabled).
2. Any non-number value returns `{ ok: false, reason: "not-a-number" }`.
3. Number processing order: `!Number.isFinite(value)` -> `"not-finite"`;
   `!Number.isInteger(value)` -> `"not-an-integer"`; `value < 0` -> `"negative"`;
   `!Number.isSafeInteger(value)` -> `"unsafe-integer"`; otherwise
   `{ ok: true, value: value === 0 ? 0 : value }` (normalizes `-0` to `0`).

`parseModelRateLimitDraftText`:

1. Trims the input. `""` returns `{ ok: true, value: undefined }` (clear).
2. Accepts only canonical non-negative decimal integer text matching
   `/^(0|[1-9][0-9]*)$/` (after trim). Reject `+5`, `-0`, `007`, `1e3`, `1.5`,
   `0x10`, `1_000`, whitespace-embedded text, and any non-digit text with
   `{ ok: false, reason: "not-a-number" }`. This deliberately avoids silent
   conversions such as `1e3` -> `1000`.
3. A canonical integer above `Number.MAX_SAFE_INTEGER` returns
   `{ ok: false, reason: "unsafe-integer" }`.

`modelRateLimitValuesFromEntry`:

1. Iterates `MODEL_RATE_LIMIT_FIELDS` in declaration order (`tpm` before `rpm`).
2. Validates each present field with `parseModelRateLimitStoredValue`; the first
   failure returns `{ ok: false, field, reason }`.
3. Returns `{ ok: true, values }` containing only positive parsed values; omitted
   and `0` dimensions are absent from `values`.

`sumModelTerminalTokens`:

1. Accepts an arbitrary unknown object.
2. Reads `input`, `output`, `cacheRead`, `cacheWrite`.
3. Each counter contributes `0` unless it is a finite number greater than `0`.
   Negative, `NaN`, `Infinity`, strings, `null`, missing fields, and non-number
   values contribute `0`.
4. Returns the sum. `totalTokens` is never added; it is a derived field that already
   contains `input + output`.
5. Never returns `NaN`, `Infinity`, or a negative number.

`modelRateLimitFieldMessage` returns stable text used by API errors and dialog
messages:

- `"tpm"`/`"not-a-number"`: `"Tokens per minute must be a whole number."`
- `"rpm"`/`"not-a-number"`: `"Requests per minute must be a whole number."`
- `"not-finite"`, `"not-an-integer"`, `"negative"`, `"unsafe-integer"`:
  field label plus `" must be a non-negative whole number."`
- `"missing-model-id"`: `"Set a Model ID before setting rate limits."`

### 3.3 Server Limits Snapshot and Identity

New file `src/server/rateLimits/modelRateLimitConfig.ts` owns extraction and
collision-safe identity.

```ts
export interface ModelRateLimitIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export interface ModelRateLimitValidationError {
  provider: string;
  modelId: string;
  occurrence: number;
  field: ModelRateLimitField;
  reason: ModelRateLimitInvalidReason;
  message: string;
}

export interface ModelRateLimitSnapshot {
  /** provider -> modelId -> enabled values. Empty providers/models are absent. */
  readonly limits: ReadonlyMap<string, ReadonlyMap<string, ModelRateLimitValues>>;
}

export type ModelRateLimitExtraction =
  | { ok: true; snapshot: ModelRateLimitSnapshot }
  | { ok: false; errors: readonly ModelRateLimitValidationError[] };

export function emptyModelRateLimitSnapshot(): ModelRateLimitSnapshot;
export function extractModelRateLimits(document: ModelsConfigDocument): ModelRateLimitExtraction;
export function modelRateLimitValuesFor(
  snapshot: ModelRateLimitSnapshot,
  identity: ModelRateLimitIdentity,
): ModelRateLimitValues | undefined;
```

Identity rules:

1. Identity is the exact `provider` string plus the exact `id` string. No trimming,
   case folding, display name, thinking level, tier, session, or workspace
   participates.
2. Storage uses nested maps (`Map<string, Map<string, ModelRateLimitValues>>`).
   Identities are never encoded into a single delimiter-joined string anywhere in
   server code. This removes separator-collision ambiguity entirely.
3. Human-readable labels for logs use `provider + "/" + modelId` for display only,
   never for lookup.

Extraction rules:

1. Read `document.providers` in JavaScript property enumeration order. For each
   provider, process its `models[]` entries in array order; collect errors in that
   deterministic traversal order so "first error" selection is stable.
2. Absent `providers` means an empty snapshot.
3. For each provider record, read `models`; absent or empty means no identities.
4. Process `models[]` entries in array order. For each entry:
   - `occurrence` is the zero-based count of previously seen entries with the same
     exact `id` within that provider array.
   - If the entry is not a record, skip it (shape validation rejects it earlier).
   - If the entry has no non-empty string `id`:
     - if it has a `tpm` or `rpm` field, collect a `missing-model-id` error for that
       field with `modelId: ""` and the current occurrence;
     - otherwise skip the entry.
   - Validate the entry with `modelRateLimitValuesFromEntry`. On failure, collect a
     validation error and continue with the next entry.
   - On success, assign the entry's values to the provider/model identity **even
     when `values` is empty**. This is the duplicate-ID last-entry rule: a later
     duplicate replaces the identity's values with its own occurrence values, and an
     omitted field on that later entry disables the dimension rather than inheriting
     from an earlier duplicate. It matches Pi 0.85.1's sequential
     `models.findIndex(...)` then in-place replacement in
     `dist/core/provider-composer.js`.
5. After processing, drop every identity whose final `values` has no enabled
   dimension. The returned maps contain only identities with at least one positive
   limit.
6. Collect **all** validation errors; the first error does not stop later entries.
7. Any collected error rejects the whole snapshot. A syntactically valid document
   with an invalid limit is never activated as unlimited.
8. Errors are ordered by provider key insertion order, then model entry order, then
   `tpm` before `rpm`.

### 3.4 API Types

Extend `src/shared/apiTypes.ts`:

```ts
export interface ModelsConfigModel {
  /** ... existing members ... */
  tpm?: number | undefined;
  rpm?: number | undefined;
}
```

`ModelsConfigSaveResponse` becomes backward-compatible and additive:

```ts
export interface ModelsConfigSaveResponse {
  success: true;
  contractVersion?: 1;
  revision?: number;
}
```

The existing `GET /models-config` continues to return `ModelsConfigDocument`
unchanged. The document response is the saved draft; it is never replaced by an
empty document on a parse failure.

New sidecar response returned by `GET /models-config/limits`:

```ts
export type ModelsConfigLimitsAdmission = "ready" | "blocked";
export type ModelsConfigLimitsSource =
  | "none"
  | "missing-file"
  | "accepted-document"
  | "last-known-good";

export interface ModelsConfigLimitsStatusResponse {
  contractVersion: 1;
  /** 0 until this process accepts its first valid snapshot. */
  revision: number;
  admission: ModelsConfigLimitsAdmission;
  source: ModelsConfigLimitsSource;
  /** Present when admission is blocked or a last-known-good snapshot is active. */
  error?: string;
}
```

New error body used by models-config routes:

```ts
export type ModelsConfigErrorCode =
  | "MODELS_CONFIG_PARSE_FAILED"
  | "MODELS_CONFIG_IO_FAILED"
  | "MODELS_CONFIG_SAVE_INVALID"
  | "MODELS_CONFIG_INVALID_LIMITS"
  | "MODELS_CONFIG_UNREADABLE"
  | "MODELS_CONFIG_PERSIST_FAILED"
  | "MODELS_CONFIG_REFRESH_FAILED"
  | "MODELS_CONFIG_INTERNAL";

export interface ModelsConfigErrorResponse {
  /** Existing human-readable message; kept for old clients. */
  error: string;
  code: ModelsConfigErrorCode;
  /** Always "models.json" for this feature. */
  file: "models.json";
  provider?: string;
  modelId?: string;
  field?: ModelRateLimitField;
  /** Machine-readable validation reason when one field is invalid. */
  reason?: ModelRateLimitInvalidReason;
  occurrence?: number;
  /** True only on MODELS_CONFIG_REFRESH_FAILED after a successful write. */
  persisted?: boolean;
}
```

Request shapes for `POST /models-config/test` and `POST /models-config/discover`
are unchanged.

### 3.5 Client Draft Contract

The dialog keeps raw draft text per identity so invalid input is never rounded and
never silently becomes unlimited.

```ts
export interface ModelRateLimitFieldDraft {
  /** Text shown in the numeric input. "" means clear. */
  text: string;
  /** Raw loaded value when the stored value cannot be represented as input text. */
  loadedInvalidValue?: unknown;
  /** Present while this field is invalid; blocks Save. */
  error?: string;
}

export interface ModelRateLimitDraft {
  tpm: ModelRateLimitFieldDraft;
  rpm: ModelRateLimitFieldDraft;
}

export type ModelRateLimitDraftMap = Record<string, ModelRateLimitDraft>;
```

Draft identity:

1. `rateLimitDraftKey(providerName, modelId, occurrence)` returns
   `JSON.stringify(["model-rate-limit-draft", providerName, modelId, occurrence])`.
   JSON array encoding is unambiguous and collision-safe; never use separator
   concatenation or a mutable array index.
2. `occurrence` is the zero-based ordinal of the entry among entries with the same
   exact `id` in that provider's `models` array in the document the draft was
   derived from.
3. A draft is invalid when either field has `error` set, including a loaded invalid
   value. Save is blocked by any invalid draft in the map, not only the selected
   entry.

New pure helpers live in `src/client/src/components/models/modelsConfigDraft.ts`
alongside the existing document helpers:

```ts
export function rateLimitDraftKey(providerName: string, modelId: string, occurrence: number): string;
export function modelRateLimitDraftsFromDocument(document: ModelsConfigDocument): ModelRateLimitDraftMap;
export function applyRateLimitDraftField(
  draft: ModelRateLimitDraft,
  field: ModelRateLimitField,
  text: string,
): ModelRateLimitDraft;
export function setModelRateLimitField(
  model: ModelsConfigModel,
  field: ModelRateLimitField,
  value: number | undefined,
): ModelsConfigModel;
export type RateLimitDraftReconciliationChange =
  | { type: "rename"; providerName: string; from: string; to: string }
  | { type: "delete"; providerName: string; modelId: string; occurrence: number };

export function reconcileRateLimitDrafts(
  drafts: ModelRateLimitDraftMap,
  previousDocument: ModelsConfigDocument,
  nextDocument: ModelsConfigDocument,
  change?: RateLimitDraftReconciliationChange,
): ModelRateLimitDraftMap;
export function firstInvalidRateLimitDraft(
  drafts: ModelRateLimitDraftMap,
): { key: string; providerName: string; modelId: string; field: ModelRateLimitField; message: string } | undefined;
```

Behavior:

1. `modelRateLimitDraftsFromDocument` derives one draft per `models[]` entry using
   `parseModelRateLimitStoredValue`:
   - omitted -> `{ text: "" }`;
   - valid number -> `{ text: String(value) }`;
   - invalid stored value -> `{ text: "", loadedInvalidValue: value, error: message }`.
2. `applyRateLimitDraftField` trims nothing on display; it stores the raw input
   text, clears `loadedInvalidValue`, and recomputes `error` with
   `parseModelRateLimitDraftText`.
3. Applied valid edits mutate the document through `setModelRateLimitField`, which
   sets the numeric field or deletes it when `undefined`. Invalid drafts never
   mutate the document.
4. `reconcileRateLimitDrafts` matches old drafts to new entries by identity. When a
   rename change is supplied, it remaps only the matching provider/model identity
   rather than every draft key. When a delete change is supplied, it drops the
   deleted `(providerName, modelId, occurrence)` draft and shifts drafts for later
   occurrences of that same provider/model down by one before matching them to the
   next document. It keeps raw invalid text for matches, derives fresh drafts for
   unmatched new entries, and drops drafts for removed entries or occurrences that
   no longer exist. It is called after add/delete/rename so an explicitly deleted
   entry clears its draft and later duplicates shift occurrence deterministically.
   An orphaned invalid draft therefore cannot block Save after a model-ID rename or
   deletion.
5. `reconcileRateLimitDrafts` is pure and must not read the DOM or timers.

---

## 4. Parser and Validation

### 4.1 Pi-Compatible Parser

New file `src/server/models/modelsJsonParser.ts`:

```ts
export class ModelsJsonParseError extends SyntaxError {
  constructor(message: string, options?: { cause?: unknown });
}

export function stripModelsJsonBom(content: string): string;
export function stripModelsJsonComments(input: string): string;
export function parseModelsJsonText(content: string): unknown;
```

Implementation requirements (mirrors installed Pi 0.85.1
`dist/utils/text.js` and `dist/utils/json.js`; add a comment naming that source):

```ts
// Pi 0.85.1 compatibility: leading BOM, `//` line comments, trailing commas.
export function stripModelsJsonBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function stripModelsJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) =>
      match[0] === '"' ? match : "")
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail: string | undefined) =>
        tail ?? (match[0] === '"' ? match : ""),
    );
}
```

`parseModelsJsonText` strips the BOM, strips `//` comments and trailing commas, then
calls `JSON.parse`. A `JSON.parse` failure is wrapped in `ModelsJsonParseError` with
the original message preserved. This parser is the only production parser used for
`models.json` text.

Accepted syntax (must match Pi):

- optional leading `\uFEFF`;
- `//` line comments outside string literals;
- trailing commas before `}` or `]`, including whitespace and newlines before the
  closing token;
- duplicate object keys follow `JSON.parse` last-key-wins semantics.

Rejected syntax (must match Pi):

- `/* */` block comments;
- `#` comments;
- unquoted keys, single-quoted strings, `NaN`, `Infinity`, and any other JSON5
  extension;
- a trailing comma followed by another comma or a non-empty tail.

### 4.2 Document Shape Validation

One pure shape validator is shared by read and save:

```ts
export function validateModelsConfigDraftShape(
  value: unknown,
): { ok: true; document: ModelsConfigDocument } | { ok: false; message: string };
```

Rules:

1. The top level must be a plain object (not an array, not `null`); otherwise
   `"models.json must be a JSON object"`.
2. `providers` may be absent (normalized to `{}` while preserving all other root
   keys) or a plain object; an array or non-object is invalid.
3. Each provider value must be a plain object.
4. `models` may be absent or an array; any other value is invalid.
5. Each `models[]` entry must be a plain object.
6. Each entry's `id` must be a string (empty string is allowed so the dialog can
   show and repair a new entry).
7. No other field is shape-validated by this function. Unknown fields are preserved
   by returning `{ ...value, providers }` with each provider and entry left as-is
   apart from normalization of an absent `providers`.

Read and save paths:

- Read: `parseModelsJsonText` then `validateModelsConfigDraftShape`. A parse or
  shape failure produces `MODELS_CONFIG_PARSE_FAILED`; there is no empty-document
  fallback. A missing file produces `{ providers: {} }`.
- Save: the already-parsed request body is validated with the same function; a
  failure produces `MODELS_CONFIG_SAVE_INVALID`.
- The save guard re-reads the on-disk file with the same parse and shape steps; a
  failure produces `MODELS_CONFIG_UNREADABLE` before any write.

### 4.3 Limits Validation and Extraction

After shape validation, `extractModelRateLimits` runs in both the read path and the
save path with identical semantics:

- Read: an extraction failure does not reject the HTTP response; the document is
  returned so the dialog can display and repair the invalid fields. The sidecar
  endpoint does not republish and the active snapshot is untouched.
- Save: an extraction failure rejects the request with
  `MODELS_CONFIG_INVALID_LIMITS` and no write, naming the provider, model ID,
  occurrence, field, and reason.

Pi-schema concerns outside this shape validator are not duplicated. A document that
Pi rejects surfaces through `ModelRuntime.getError()` during refresh validation
(Section 7.5).

### 4.4 Pi Compatibility Evidence

`src/server/rateLimits/modelRateLimitPiCompatibility.test.ts` loads equivalent
fixtures through the installed public runtime
(`ModelRuntime.create({ modelsPath, authPath, allowModelNetwork: false })`) and
asserts:

1. Model behavior is identical with and without `tpm`/`rpm`: per provider, compare
   `getModels(provider)` ids, `api`, `baseUrl`, `contextWindow`, `maxTokens`,
   `reasoning`, `thinkingLevelMap`, `input`, `cost`, and merged `compat`.
2. `getError()` is `undefined` for both fixtures.
3. Unknown root/provider/model fields are preserved in
   `getProvider(provider)` and are not reinterpreted.
4. Fixtures using BOM, `//` comments, and trailing commas load; a fixture using a
   block comment fails through both PI WEBUI's parser and the installed runtime.
5. Duplicate model IDs resolve through the installed runtime with the last
   definition winning, and PI WEBUI's extracted limits agree with the last entry.
6. The `models.json` fixture text and file metadata are unchanged after loading;
   the runtime never rewrites the source file.
7. Credentials configuration remains unchanged: `getAuth` behavior for an unrelated
   provider and the composed provider auth surface are the same for both fixtures.

---

## 5. Limiter Semantics

### 5.1 Clock and Timer Injection

New file `src/server/rateLimits/modelRateLimitOwner.ts`:

```ts
export interface ModelRateLimitTimerHandle {
  cancel(): void;
}

export interface ModelRateLimitClock {
  /** Monotonic milliseconds. Never wall-clock time. */
  now(): number;
  schedule(delayMs: number, callback: () => void): ModelRateLimitTimerHandle;
}

export const modelRateLimitDefaultClock: ModelRateLimitClock = {
  now: () => performance.now(),
  schedule: (delayMs, callback) => {
    const handle = setTimeout(callback, Math.max(0, delayMs));
    return { cancel: () => { clearTimeout(handle); } };
  },
};

export interface ModelRateLimitOwnerLogger {
  warn(details: Record<string, unknown>, message: string): void;
}
```

The owner takes `clock` and `logger` through
`createModelRateLimitOwner(options?: { clock?: ModelRateLimitClock; logger?: ModelRateLimitOwnerLogger })`.
The owner must not import `node:fs`, `node:http`, Fastify, or any UI module.

### 5.2 Owner Interface

```ts
export const MODEL_RATE_LIMITS_BLOCKED_CODE = "MODEL_RATE_LIMITS_BLOCKED";
export const MODEL_RATE_LIMITS_BLOCKED_MESSAGE =
  "Model requests are blocked because the model configuration is invalid.";

export interface ModelTerminalUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

export type ModelAdmission =
  | { readonly status: "granted" }
  | { readonly status: "aborted" }
  | {
      readonly status: "blocked";
      readonly code: typeof MODEL_RATE_LIMITS_BLOCKED_CODE;
      readonly error: string;
    };

export interface ModelRateLimitOwnerStatus {
  revision: number;
  admission: "ready" | "blocked";
  source: "none" | "missing-file" | "accepted-document" | "last-known-good";
  error?: string;
}

export interface ModelRateLimitOwner {
  acquire(identity: ModelRateLimitIdentity, signal?: AbortSignal): Promise<ModelAdmission>;
  completeCall(identity: ModelRateLimitIdentity, usage: ModelTerminalUsage | undefined): void;
  applySnapshot(
    snapshot: ModelRateLimitSnapshot,
    source: "missing-file" | "accepted-document",
  ): number;
  reportLoadFailure(error: string): void;
  readStatus(): ModelRateLimitOwnerStatus;
  dispose(): void;
  /** Diagnostics and tests only. */
  pendingWaiterCount(identity?: ModelRateLimitIdentity): number;
  activeTimerCount(): number;
}
```

### 5.3 State and Admission

Per identity state:

```ts
interface ModelCallBudgetState {
  limits: ModelRateLimitValues;             // normalized; only positive values
  requestTimestamps: number[];              // monotonic dispatch times, oldest first
  tokenUsages: Array<{ at: number; tokens: number }>;
  queue: ModelCallWaiter[];                 // FIFO
  timer: ModelRateLimitTimerHandle | undefined;
  inFlight: number;
  queuedLogged: boolean;
}

interface ModelCallWaiter {
  resolve(result: ModelAdmission): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}
```

`pruneIdleEntries` removes an identity state only when its queue is empty, its
request and token histories are empty, `inFlight === 0`, and its current `limits`
object is empty. It is called after completion and after snapshot publication;
states with active work, retained history, queued waiters, or configured limits are
kept.

Derived admission checks, evaluated at monotonic `now` after pruning:

1. `prune(state, now)`: remove every `requestTimestamps[0]` and every
   `tokenUsages[0]` whose timestamp is `<= now - MODEL_RATE_LIMIT_WINDOW_MS`.
   Entries with timestamp strictly greater than `now - 60000` remain. An entry
   expires exactly 60,000 ms after its timestamp.
2. `prmDisabled = limits.rpm === undefined`; `tpmDisabled = limits.tpm === undefined`.
3. `canAdmit(state, now)` is `true` only when both enabled conditions hold:
   - `prmDisabled || state.requestTimestamps.length < limits.rpm`;
   - `tpmDisabled || retainedTokenSum(state) < limits.tpm`.
4. Equality is not admission: `length < rpm` and `sum < tpm` are strict.

### 5.4 Queue, Wakeup, Cancellation, Shutdown Algorithms

`acquire(identity, signal)`:

1. If `signal?.aborted === true`, return `{ status: "aborted" }` immediately; do not
   create state and do not spend a RPM unit.
2. If the owner admission state is `blocked`, return
   `{ status: "blocked", code, error }` immediately. Never queue while blocked.
3. Get or create the identity state and call `prune(state, clock.now())` before every
   admission decision. If the identity queue is empty and `canAdmit(state, now)`:
   - append `now` to `requestTimestamps` and increment `inFlight` synchronously;
   - return `{ status: "granted" }`.
   Admission and RPM recording happen in the same synchronous decision, before the
   delegate is invoked, so concurrent admissions cannot spend the last request slot
   twice.
4. Otherwise create a waiter, push it to the FIFO queue, register a one-shot abort
   listener when a signal exists, run `drain(state)`, run `schedule(state)`, and
   return the waiter result. A new arrival never jumps ahead of existing waiters,
   even when limits would allow it.

`drain(state)`:

1. Call `prune(state, clock.now())` before evaluating the queue. Loop while the queue
   is non-empty:
   - if the head waiter's `signal?.aborted === true`, remove it, remove its abort
     listener, settle it `{ status: "aborted" }`, and continue (a cancelled head
     never starves the next waiter);
   - if `!canAdmit(state, now)`, stop;
   - remove the head, remove its abort listener, append `now` to
     `requestTimestamps`, increment `inFlight`, and settle it `{ status: "granted" }`.
2. After the loop, cancel and clear the timer when the queue is empty; otherwise run
   `schedule(state)`.

`schedule(state)`:

1. When the queue is empty or the state has no retained request or token history,
   cancel any timer and stop. A queued state with no history must have been
   admitted by `drain`; scheduling a zero-delay timer for it is forbidden.
2. Compute `earliest = min(requestTimestamps[0] ?? Infinity, tokenUsages[0]?.at ?? Infinity)`
   and `delay = max(0, earliest + MODEL_RATE_LIMIT_WINDOW_MS - now)`.
3. Cancel any existing timer, then schedule exactly one timer. The callback prunes
   the state, runs `drain`, and runs `schedule`. There is at most one active timer
   per identity; per-token-delta timers and polling are forbidden.

Abort listener:

1. On abort, if the waiter is already settled, do nothing.
2. Mark settled, remove it from the queue (a non-head waiter is removed in place),
   remove the abort listener, and settle it `{ status: "aborted" }`.
3. If the removed waiter was the head, run `drain` so the next waiter can proceed.
4. Run `schedule` so an obsolete timer is cancelled when the queue becomes empty.

`completeCall(identity, usage)`:

1. Decrement `inFlight` (never below zero).
2. Compute `tokens = sumModelTerminalTokens(usage)`.
3. When `tokens > 0`, append `{ at: now, tokens }` to `tokenUsages`.
4. Call `prune(state, now)` and run `drain` and `schedule` when the identity queue
   is non-empty so newly recorded usage cannot be masked by a stale timer decision.
5. When the identity has no retained history, no queue, and `inFlight === 0`, call
   `pruneIdleEntries` immediately; otherwise retain the state.

`applySnapshot(snapshot, source)`:

1. For each identity in the snapshot, update `limits` while preserving
   `requestTimestamps`, `tokenUsages`, and queue. Recent usage survives limit
   changes, including disable/enable toggles and ordinary provider edits.
2. For each existing state not present in the snapshot, set `limits` to `{}`. Work
   is not cancelled and is never retargeted to another model.
3. Drain every state with a queue and reschedule timers, because raising or
   disabling a limit wakes eligible waiters immediately.
4. Increment and return the revision. Set admission `ready`, set `source`, and clear
   the error.
5. A queued or in-flight call keeps the identity captured at `acquire` time. A
   provider or model rename in the new snapshot affects only new acquires; an
   already-started call still reports usage under its original identity.
6. Run `pruneIdleEntries`: delete states with an empty queue, empty histories,
   `inFlight === 0`, and no limits in the current snapshot.

`reportLoadFailure(error)`:

1. When at least one snapshot has been accepted (revision `> 0`), keep admission
   `ready`, keep the existing limits, set `source = "last-known-good"`, and record
   `error`.
2. When no snapshot has ever been accepted, set admission `blocked`, keep
   `source = "none"`, and record `error` so every `acquire` fails closed with the
   structured error instead of queueing indefinitely or appearing unlimited.

`dispose()`:

1. Mark disposed. Every later `acquire` returns `{ status: "aborted" }`; later
   `completeCall` is a no-op.
2. Cancel every timer, remove every abort listener, and settle every waiter with
   `{ status: "aborted" }`.
3. Clear all state. After `dispose`, `pendingWaiterCount()` and `activeTimerCount()`
   return `0`.

### 5.5 Boundaries, Overshoot, Disabled Dimensions

1. **Window.** Retain entries with timestamp `> now - 60000`; an entry expires
   exactly at `timestamp + 60000`.
2. **Disabled dimensions.** Omitted or `0` disables a dimension independently. With
   both disabled, `acquire` grants immediately and never queues. With `rpm = 22` and
   `tpm` omitted, only the request count applies, and vice versa.
3. **Overshoot.** Actual-usage accounting is not a hard ceiling. Any admitted
   request, including the first, can report more tokens than `tpm`. Concurrent
   in-flight calls can overshoot. Already-dispatched calls are allowed to finish;
   later calls wait until recorded usage falls below `tpm`.
4. **No reservation.** `maxTokens`, prompt size, and streaming deltas are never
   counted. Only terminal usage is recorded.
5. **Per-dispatch RPM.** RPM counts admission to an underlying model-call dispatch.
   Internal transport retries are part of that dispatch and keep Pi's behavior.
   Application-level retries that invoke the model-call interface again are new
   requests. A thrown error without usage still consumes its dispatched RPM unit.
   Pre-dispatch aborts consume nothing.
6. **No cross-model blocking.** Queues and timers are per identity. Requests for
   other models progress independently.
7. **FIFO ordering.** FIFO governs dispatch order, not completion order.
8. **Diagnostics.** Log at most one `warn` per identity when its queue transitions
   from empty to non-empty (with `provider`, `modelId`, and the exhausted
   dimension) and one `warn` per blocked-admission report. Never log prompts,
   completions, credentials, or API keys. No per-waiter or per-timer logging.

---

## 6. Adapter Contracts

New file `src/server/rateLimits/modelRateLimitAdapters.ts`. Adapters contain no
limiter policy of their own; they call the owner and translate outcomes into Pi's
stream/completion protocol.

### 6.1 Stream Adapter

```ts
import type { StreamFn } from "@earendil-works/pi-agent-core";

export function wrapModelStream(owner: ModelRateLimitOwner, delegate: StreamFn): StreamFn;
```

Wrapping rules:

1. The wrapper returns an `AssistantMessageEventStream` synchronously and starts an
   eager asynchronous pump in the same tick.
2. The module defines one private, module-scoped symbol constant for the wrapper tag,
   for example `const MODEL_RATE_LIMIT_WRAPPED = Symbol("pi-webui.modelRateLimitWrapped")`.
   The wrapper sets that symbol as a non-enumerable property and
   `wrapModelStream` returns the delegate unchanged when the same symbol is already
   present, so a session is never double-wrapped and a call is never double-counted.
3. The delegate is preserved exactly. Auth, headers, retry, thinking level,
   `maxTokens`, `timeoutMs`, `signal`, and every other option are forwarded
   unchanged. The wrapper adds no request payload fields and changes no model data.
4. Identity is `{ provider: model.provider, modelId: model.id }` captured from the
   model argument at call time, so utility fallback candidates, model switches, and
   naming calls charge the actual argument model.

Pump algorithm:

1. `admission = await owner.acquire(identity, options?.signal)`.
   - `blocked` -> settle with a synthesized terminal `error` message whose
     `errorMessage` starts with `MODEL_RATE_LIMITS_BLOCKED_MESSAGE` followed by the
     owner error; do not invoke the delegate; do not call `completeCall`.
   - `aborted` -> settle with a synthesized terminal `aborted` message;
     do not invoke the delegate; do not call `completeCall`.
   - `granted` -> continue. A RPM unit is already charged.
2. Invoke the delegate inside `try`/`catch` and await a returned promise when
   present. A synchronous throw or rejected promise settles with a synthesized
   terminal `error` message carrying the error text, then calls
   `owner.completeCall(identity, undefined)` exactly once.
3. Immediately begin `for await (const event of delegateStream)` and push each
   event into the wrapper stream in order. This eager consumption is required so a
   `.result()`-only consumer receives the terminal result, terminal accounting
   still occurs when the caller stops iterating, and Pi's lazy stream setup is
   forced.
4. On a terminal event (`type === "done"` or `type === "error"`):
   - read the terminal `AssistantMessage` (`event.message` for `done`,
     `event.error` for `error`);
   - call `owner.completeCall(identity, message.usage)` before pushing the terminal
     event or resolving `.result()`, so an immediate follow-up call observes the
     usage;
   - push the terminal event to the wrapper stream;
   - call `wrapper.end(message)` once and stop consuming the delegate.
5. When the delegate iterator completes without a terminal event, settle with a
   synthesized terminal `error` message
   `"Model stream ended without a final result."` and call
   `owner.completeCall(identity, undefined)`.
6. When the delegate iterator throws, settle with a synthesized terminal `error`
   message carrying the thrown error, then `completeCall(identity, undefined)`.
7. A single `settled` guard shared by iteration and `.result()` paths guarantees one
   `end`, one terminal push, and one `completeCall`. Duplicate terminal events from
   a delegate are ignored for accounting.
8. The `completeCall` call is in a `finally`-equivalent path so a delegate that
   resolves without any events, a wrapper stream that is never iterated, and a
   caller that drops its iterator all release `inFlight` and never strand a waiter,
   timer, or promise.

### 6.2 Completion Adapter

```ts
export type ModelCompletionFunction = (
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

export function wrapModelCompletion(
  owner: ModelRateLimitOwner,
  delegate: ModelCompletionFunction,
): ModelCompletionFunction;
```

Rules:

1. Identity, admission, and blocked/abort mapping match the stream adapter.
2. On grant, await the delegate and then resolve the returned `AssistantMessage`
   after calling `owner.completeCall(identity, message.usage)` exactly once. Usage
   is recorded before the promise resolves.
3. A pre-dispatch `blocked` admission resolves (does not reject) a synthesized
   `error` `AssistantMessage`; a pre-dispatch `aborted` admission resolves a
   synthesized `aborted` `AssistantMessage`. This matches Pi's
   `completeSimple(...).result()` convention of resolving terminal messages.
4. A delegate rejection rejects with the original error and calls
   `owner.completeCall(identity, undefined)` exactly once before rejecting.
5. The adapter never wraps `ModelRuntime.streamSimple` or the shared runtime
   underneath; each completion surface wraps exactly one function so the call is
   charged exactly once.

### 6.3 Synthesized Terminal Representation

Every synthesized terminal message uses the shape Pi itself produces:

```ts
{
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error" | "aborted",
  errorMessage: string,
  timestamp: Date.now(),
}
```

The wrapper pushes `{ type: "error", reason: "error" | "aborted", error: message }`
and calls `end(message)`. Pre-dispatch abort uses `errorMessage: "Request was
aborted"`, matching Pi's own abort representation. Blocked admission uses
`errorMessage: MODEL_RATE_LIMITS_BLOCKED_MESSAGE + " " + ownerError`.

---

## 7. Daemon and Configuration Lifecycle

### 7.1 Startup

`sessiond` creates exactly one owner per process inside the existing
`createRuntime()` callback in `src/server/sessiond.ts`, after `AuthService.create`
and before any route is registered:

```ts
const rateLimits = createModelRateLimitOwner({ logger: app.log });
const models = new ModelsConfigService({
  agentDir: activeAgentProfile.dir,
  modelRuntime: auth.runtime,
  rateLimits,
  logger: app.log,
});
await models.initialize();
```

`initialize()` never throws. It reads `models.json` using a read helper that first
checks whether the path exists (or returns an explicit `missing` result for ENOENT),
then parses and shape-validates, extracts limits, and either:

- publishes an empty snapshot with source `missing-file` when the file is absent;
- publishes the accepted snapshot with source `accepted-document`;
- calls `reportLoadFailure` with a structured message when the file fails to parse,
  fails shape validation, fails limits extraction, or fails to read because of a
  non-ENOENT I/O error, and logs one `warn` with
  `{ file: "models.json", err }`.

A daemon with no accepted snapshot starts in admission `blocked`. Configuration and
error-reporting routes remain available. A daemon with an accepted snapshot keeps
using it for the process lifetime unless a later save publishes a new one. Startup
does not enter a credential, catalog, or network retry loop; recovery from a
blocked state is a valid document accepted through the Models GUI (or a restart
after an external fix).

### 7.2 Save: Persist, Refresh, Publish

`ModelsConfigService.save(value)` runs inside the same serialized operation chain as
`initialize()` and executes these steps in order:

1. Validate the request body with `validateModelsConfigDraftShape`; failure ->
   `MODELS_CONFIG_SAVE_INVALID`, no write.
2. Extract limits with `extractModelRateLimits`; failure ->
   `MODELS_CONFIG_INVALID_LIMITS` naming the first error's provider/model/field/
   reason/occurrence, no write.
3. Re-read the on-disk `models.json` (missing file is allowed) and parse it with the
   Pi-compatible parser and shape validator. A parse or shape failure ->
   `MODELS_CONFIG_UNREADABLE`, no write. This protects a malformed file from being
   replaced by a stale empty draft even when an older client attempts the save.
4. Atomically persist the normalized document (Section 7.3). An I/O failure ->
   `MODELS_CONFIG_PERSIST_FAILED`; active limits are unchanged.
5. Refresh the shared runtime with `modelRuntime.refresh({ allowNetwork: false })`
   and apply the narrow refresh validation from Section 7.5. A refresh failure ->
   `MODELS_CONFIG_REFRESH_FAILED` with `persisted: true`; the last accepted snapshot
   stays active and the dialog is told the file and live state differ.
6. Publish: `rateLimits.applySnapshot(extractedSnapshot, "accepted-document")`. This
   increments the revision, replaces limits while keeping recent usage, drains every
   queue, and wakes eligible waiters.
7. Return `{ success: true, contractVersion: 1, revision }`.

"Reloading" the dialog reads the draft only. It never publishes limits.

### 7.3 Atomic Persistence

The current `writeFile` call is not crash-safe, so `ModelsConfigService` replaces it
with:

1. Resolve the effective write target before creating a temporary file, following
   symlinks and resolving the physical parent with the same semantics as
   `resolveWriteTarget` in `src/server/storage/projectStore.ts`. Use that effective
   target path and parent for `stat`, the temporary file, and `rename`; this keeps a
   symlinked `models.json` updating its target instead of replacing the link. A
   non-ENOENT resolution failure is a persist failure with no temporary file.
2. `mkdir(dirname(effectiveTargetPath), { recursive: true })`.
3. Before creating the temporary file, `stat(effectiveTargetPath)` when it exists and
   record its permission bits (`mode & 0o7777`). If the file does not exist, use the
   current default creation mode. Create the sibling temporary file with the
   recorded mode as the `open` mode argument; never create it with a broader mode
   and repair it afterward. This preserves a restricted file such as `0600`
   throughout replacement.
4. Create a sibling temporary file named
   `<effective-basename>.<pid>.<randomUUID()>.tmp` in the effective target directory.
5. Write exactly `` `${JSON.stringify(document, null, 2)}\n` `` as UTF-8.
6. `fsync` the file handle, then close it.
7. `rename` the temporary file over the effective target (atomic on the same
   filesystem).
8. On any failure after the temporary file is created, unlink the temporary file and
   rethrow as `MODELS_CONFIG_PERSIST_FAILED`. Never leave the temporary file behind,
   never truncate `models.json` in place, and never partially rewrite it.

Atomic rename cannot preserve the shared inode semantics of a hard link. If the
resolved target has `nlink > 1`, reject the write as `MODELS_CONFIG_PERSIST_FAILED`
before creating a temporary file rather than silently updating only one directory
entry. The symlink-target and hard-link cases are covered by persistence tests.

The replacement preserves the existing file's permission bits and uses the current
creation mode for a new file. Directory fsync is not required for the initial feature;
a crash immediately after rename can leave either the old or new complete file, never
partial JSON. Record this durability boundary in the operational handoff.

### 7.4 Serialization and Revisions

1. `ModelsConfigService` keeps one operation chain
   (`private operationChain: Promise<void>`). `initialize`, `save`, and any future
   publication run serially through it. A failed operation never poisons the chain;
   the next operation still runs.
2. The owner owns the revision counter. It starts at `0`, increments on every
   accepted snapshot publication, and is returned by `applySnapshot`.
3. `read()` and `readLimitsStatus()` may run concurrently with a save. They never
   publish and never mutate the active snapshot. `read()` may observe either the
   old or the new file because the rename is atomic.
4. Because saves are serialized and each publish happens inside its own save
   critical section, an older save can never publish over a newer accepted
   configuration.

### 7.5 Narrow Refresh Failure Definition

`refresh()` may throw, and its result may carry catalog/provider errors. Transient
model availability, authentication, and catalog errors must not be confused with a
configuration refresh failure. The exact rule:

1. Call `modelRuntime.refresh({ allowNetwork: false })`.
2. The refresh is a **failure** when:
   - the call rejects; or
   - the resolved result has `aborted === true`; or
   - `modelRuntime.getError()` after the refresh contains a `models.json` load,
     parse, or schema failure. The stable prefixes produced by Pi 0.85.1 are
     `"Failed to load models.json:"`, `"Failed to parse models.json:"`, and
     `"Invalid models.json schema:"`; or
   - `modelRuntime.getError()` contains a provider composition error
     (`Provider "<name>": ...`) whose provider name is a provider key in the
     just-persisted document. Composition errors for providers removed by this save
     are ignored.
3. The refresh is **not** a failure for:
   - entries in the resolved `errors` map (provider catalog/store refresh errors);
   - `"Availability refresh:"` entries in `getError()` (transient availability);
   - credential check failures;
   - catalog refresh failures.
4. The failure message is the first matching configuration error text, or the thrown
   error's message. It is reported through `MODELS_CONFIG_REFRESH_FAILED` and is
   also recorded by the owner via `reportLoadFailure` so the status sidecar can show
   why a last-known-good snapshot is active.

`modelRuntime` is typed as `Pick<ModelRuntime, "refresh" | "getError">`.

### 7.6 Shutdown and Cancellation Wiring

1. Daemon shutdown in `src/server/sessiond.ts` adds one step after sessions are
   disposed and before the server closes:
   `await attempt("dispose model rate limits", () => { rateLimits.dispose(); });`.
2. Session stop, archive, disposal, and replacement already abort active session
   operations through `abortSessionOperations` and `runtime.dispose()`. Those abort
   signals remove queued waiters and cancel post-dispatch work through the delegates;
   the limiter adds no separate session lifecycle.
3. Browser disconnects and web/API autoreloads do not abort daemon-owned sessions
   and therefore do not remove their waiters.
4. A daemon restart discards rolling histories. A web/API restart does not.

---

## 8. GUI and API Behavior

### 8.1 Routes

`src/server/models/modelsConfigRoutes.ts`:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/models-config` | Missing file -> 200 `{ providers: {} }`. Valid document -> 200 document (even when limits are invalid). Parse or shape failure -> 422 `MODELS_CONFIG_PARSE_FAILED`. I/O failure -> 500 `MODELS_CONFIG_IO_FAILED`. |
| GET | `/models-config/limits` | 200 `ModelsConfigLimitsStatusResponse`. I/O failure -> 500 `MODELS_CONFIG_IO_FAILED`. |
| PUT | `/models-config` | Success -> 200 `ModelsConfigSaveResponse`. Shape failure -> 400 `MODELS_CONFIG_SAVE_INVALID`. Limits failure -> 400 `MODELS_CONFIG_INVALID_LIMITS`. On-disk unreadable -> 409 `MODELS_CONFIG_UNREADABLE`. Write failure -> 500 `MODELS_CONFIG_PERSIST_FAILED`. Refresh failure -> 502 `MODELS_CONFIG_REFRESH_FAILED` with `persisted: true`. Unexpected -> 500 `MODELS_CONFIG_INTERNAL`. |
| POST | `/models-config/test` | Unchanged success/failure shape (`{ ok, error?, latencyMs?, status?, responseText? }`). |
| POST | `/models-config/discover` | Unchanged. |

Proxy registration:

1. `src/server/sessiond/sessionProxyRoutes.ts` adds
   `app.all(`${prefix}/models-config/limits`, (request, reply) => proxy(request, reply));`.
2. `src/shared/federatedRoutes.ts` adds
   `{ method: "GET", path: "/models-config/limits" }` to `FEDERATED_HTTP_ROUTES` so
   remote machines can report status.
3. No new capability flag is added.

### 8.2 Dialog Read

1. `GET /models-config` keeps returning the bare document. The client parser
   (`parseModelsConfigDocument` in `src/client/src/api/parsers.ts`) is extended to
   assign typed `tpm`/`rpm` when the value is a number, while preserving every other
   value (including invalid `tpm`/`rpm` values) in the copied record for the shared
   validator.
2. The dialog calls `modelsApi.config(machineId)` and, when available,
   `modelsApi.limitsStatus(machineId)` under the same load-request sequence and
   machine identity guard used today (`loadRequestSequence`, `isCurrentLoad`). Stale
   responses are ignored.
3. On a document load failure (including 422), the dialog sets a load-failed state,
   shows the error in the existing footer error area, clears the provider tree,
   discards drafts and connection-test state, and disables Save and all editing
   affordances for that load. It never substitutes an empty document for a failed
   read and never offers to overwrite the unreadable file.
4. On document success, the dialog normalizes the document and derives rate-limit
   drafts with `modelRateLimitDraftsFromDocument`. Client-side validation of the
   loaded document uses the same shared validator the server uses.
5. `readLimitsStatus` handling:
   - 200: store the status. When `admission === "blocked"`, show a non-blocking
     banner: `"Model requests are blocked: " + error`. When
     `source === "last-known-good"` and `error` is present, show
     `"Active limits come from the last accepted configuration: " + error`.
     Save stays enabled; saving a valid document is the recovery path.
   - HTTP 404: treat as unsupported (older daemon). No status, no status error, and
     no editing restrictions.
   - Any other failure: show a non-blocking footer error
     `"Failed to load rate-limit status: " + message`; editing and Save remain
     available when document validation passes.

### 8.3 Dialog Layout

The section is inserted in `renderModelDetail` after the existing
Context window / Max output tokens `.field-grid.two-columns` and before the
`cost-section`:

```text
Model: model-large

Context window (tokens)             Max output tokens
[128000                   ]        [16384                  ]

Rate limits
Tokens per minute (TPM)             Requests per minute (RPM)
[100000                   ]        [60                     ]

Cost
Input        Output        Cache read        Cache write
...

> Advanced model fields
```

Exact markup requirements:

1. Unframed `<section class="rate-limits-section">`: no border, no card background,
   and not a nested `<details>`. Do not reuse `.cost-section` or `.thinking-section`
   styling (those are framed).
2. A `span.section-label` heading with text `Rate limits`.
3. A two-column `.field-grid.two-columns` containing:
   - `label for="model-tpm"` with text `Tokens per minute (TPM)` and
     `<input id="model-tpm" type="number" min="0" step="1" inputmode="numeric">`
     with placeholder `Unlimited`;
   - `label for="model-rpm"` with text `Requests per minute (RPM)` and
     `<input id="model-rpm" type="number" min="0" step="1" inputmode="numeric">`
     with placeholder `Unlimited`.
4. Each input is followed by `field-error` text when invalid. Errors fit at mobile
   widths.
5. Existing `@media (max-width: 700px)` rules already collapse `.two-columns` to one
   column; keep that behavior and add no fixed widths.
6. The existing Save, Close, Reload, Test, provider tree, model selection, and
   machine targeting are unchanged.

### 8.4 Draft Editing and Save Gating

1. Selecting a model loads its draft values into the two inputs. Typing updates the
   draft for that entry's identity; navigation preserves each entry's draft.
2. Valid input applies to the in-memory document immediately through
   `setModelRateLimitField`. Invalid input leaves the in-memory document unchanged,
   shows the field error, and marks the draft invalid.
3. Clearing to blank deletes the field and is valid (unlimited). `0` is valid and
   stores `0`.
4. Save is disabled when `loading`, `saving`, the load failed, or any draft in the
   map is invalid. When Save is blocked by another model's invalid draft, the footer
   shows `firstInvalidRateLimitDraft` as
   `"Fix rate limits for <provider>/<modelId> before saving."`.
5. Save validates every draft again before calling the API. It never submits a
   document containing an invalid rate-limit draft, including an invalid draft on a
   different model after navigation.
6. On a structured save failure, the dialog maps `code`, `provider`, `modelId`,
   `field`, `occurrence`, and `reason`/message back to the draft and field error. `MODELS_CONFIG_
   INVALID_LIMITS` highlights the offending field;
   `MODELS_CONFIG_REFRESH_FAILED` shows that the file was saved but not activated;
   `MODELS_CONFIG_UNREADABLE` shows the reload-required message.
7. On save success, the dialog shows the existing saved message, updates the stored
   limits status from the response revision (admission `ready`), re-derives drafts
   from the saved document, and calls `onSaved`.
8. On machine change, `resetForMachineChange` also resets the draft map, the limits
   status, and any pending status sequence. Asynchronous load, status, test, and
   discovery results are ignored when the machine or load sequence changed.

### 8.5 Connection Test

1. `POST /models-config/test` keeps its existing isolated-runtime behavior and
   timeout. The final completion passes through the shared owner using the resolved
   model's `{ provider, modelId }`.
2. The temporary document built for the test may contain the request's draft
   `tpm`/`rpm`, but the limiter never reads them. Admission uses the saved active
   snapshot for the resolved identity. An unsaved draft never replaces live limits
   and never creates a private budget.
3. A queued connection test counts wait time against its existing 20-second
   `AbortController` deadline; aborting while queued removes the waiter and no
   request is dispatched later.
4. The Test button remains usable while a rate-limit draft is invalid.

### 8.6 Rolling Compatibility and Migration

1. `GET /models-config` keeps its bare-document shape in both directions, so an old
   UI talking to a new daemon and a new UI talking to a remote old daemon both read
   and save models safely.
2. A new daemon stores `tpm`/`rpm` as ordinary JSON fields; an old daemon round-trips
   them as unknown fields and Pi 0.85.1 ignores them.
3. The `GET /models-config/limits` sidecar is additive. A 404 means the selected
   machine's daemon does not enforce limits; the dialog still edits and saves the
   fields, and documentation states that enforcement requires an updated and
   restarted daemon.
4. `ModelsConfigSaveResponse` is extended additively; old clients still see
   `success: true`.
5. Error responses keep the existing `error` string field and add structured fields
   additively.
6. `PUT /models-config` refuses to write while the on-disk file is unparseable, so
   even a stale client that loaded an empty fallback cannot destroy the file.
7. Existing documents without `tpm`/`rpm` produce an empty snapshot and behave as
   before: all models unlimited.

---

## 9. Error Handling

### 9.1 Error Codes

| Code | HTTP | Trigger | Stable message start |
| --- | --- | --- | --- |
| `MODELS_CONFIG_PARSE_FAILED` | 422 | `models.json` fails Pi-compatible parse or draft shape validation on read | `models.json could not be parsed:` |
| `MODELS_CONFIG_IO_FAILED` | 500 | Read of `models.json` fails with a non-ENOENT filesystem error | `Failed to read models.json:` |
| `MODELS_CONFIG_SAVE_INVALID` | 400 | Save body fails draft shape validation | `models.json save request is not a valid configuration:` |
| `MODELS_CONFIG_INVALID_LIMITS` | 400 | A `tpm`/`rpm` value is invalid or a limits field has no model ID | field message from `modelRateLimitFieldMessage` |
| `MODELS_CONFIG_UNREADABLE` | 409 | Save attempted while the on-disk file fails to parse or shape-validate | `models.json could not be read as a valid configuration; fix the file and reload before saving.` |
| `MODELS_CONFIG_PERSIST_FAILED` | 500 | Atomic write, fsync, or rename fails | `Failed to persist models.json:` |
| `MODELS_CONFIG_REFRESH_FAILED` | 502 | Persistence succeeded but narrow refresh validation failed; body carries `persisted: true` | `models.json was saved, but the active model configuration could not be reloaded:` |
| `MODELS_CONFIG_INTERNAL` | 500 | Unmapped internal failure | `Models configuration operation failed.` |

### 9.2 Admission-Blocked Error

The owner-side stable discriminator is code `MODEL_RATE_LIMITS_BLOCKED`; it is present
on the blocked `ModelAdmission` result and is not added to Pi's
`AssistantMessage`, whose public shape has no application error-code field. The
synthesized terminal exposes the stable message prefix and owner-reason suffix, and
API/status paths expose structured codes where those contracts exist. The message
starts with `Model requests are blocked because the model configuration is invalid.`
followed by the owner's recorded reason. It is intentionally phrased without
`rate-limit` so Pi's provider retry classifier does not treat a local configuration
block as a retryable provider response. Adapter tests assert the full synthesized
`errorMessage` does not match Pi's `isRetryableAssistantError`/retry patterns, while
owner tests assert the structured code.

### 9.3 Client Error Mapping

1. New `src/client/src/api/modelsConfigError.ts` defines
   `ModelsConfigRequestError extends HttpRequestError` carrying `code`, `file`,
   `provider`, `modelId`, `field`, `occurrence`, and `persisted`, plus
   `reason` when supplied, and
   `modelsConfigErrorFromBody(body, status, fallbackMessage)` which accepts the
   structured body when present and always falls back to the `error` string.
2. `modelsConfigApi.save` uses `requestJson` so the structured body is available on
   non-2xx responses and throws `ModelsConfigRequestError`.
3. `modelsConfigApi.limitsStatus` uses `request` with the strict parser; a 404
   surfaces as `HttpRequestError` with `status === 404` and is handled as
   "unsupported".
4. `parseModelsConfigLimitsStatusResponse` rejects unknown keys, wrong
   `contractVersion`, and invalid `admission`/`source` values.
5. `parseModelsConfigSaveResponse` still requires `success === true` and parses an
   optional numeric `revision` and `contractVersion === 1` additively.

---

## 10. Integration Wiring and File Ownership

### 10.1 New Files

| Path | Responsibility |
| --- | --- |
| `src/shared/modelRateLimits.ts` | Pure value parsing, messages, terminal token sum, window constant. |
| `src/shared/modelRateLimits.test.ts` | Shared value parser and usage-sum tests. |
| `src/server/models/modelsJsonParser.ts` | Vendored Pi-compatible `models.json` text parser. |
| `src/server/models/modelsJsonParser.test.ts` | Parser dialect tests. |
| `src/server/rateLimits/modelRateLimitConfig.ts` | Snapshot extraction, identity, validation errors. |
| `src/server/rateLimits/modelRateLimitOwner.ts` | Clock/timer injection, owner, admission, accounting, publication state, shutdown. |
| `src/server/rateLimits/modelRateLimitAdapters.ts` | Stream and completion adapters, synthesized terminals, wrap guard. |
| `src/server/rateLimits/modelRateLimitTestSupport.ts` | Fake monotonic clock/timers, terminal-message and delegate-stream builders. |
| `src/server/rateLimits/modelRateLimitConfig.test.ts` | Extraction/duplicate/identity tests. |
| `src/server/rateLimits/modelRateLimitOwner.test.ts` | Window, admission, queue, cancellation, config-change, shutdown tests. |
| `src/server/rateLimits/modelRateLimitAdapters.test.ts` | Stream/completion adapter tests. |
| `src/server/rateLimits/modelRateLimitPiCompatibility.test.ts` | Installed-Pi parity tests. |
| `src/server/models/modelsConfigService.rateLimits.test.ts` | Read/save/persist/refresh/publish lifecycle tests. |
| `src/server/models/modelsConfigRoutes.test.ts` | HTTP status and structured error contract tests. |
| `src/server/sessions/piSessionService.rateLimits.test.ts` | Session runtime factory integration tests. |
| `src/server/speechInput/speechInputPolishingService.rateLimits.test.ts` | Speech-polishing completion-adapter integration tests. |
| `src/client/src/api/modelsConfigError.ts` | `ModelsConfigRequestError` and body mapping. |
| `src/client/src/components/ModelsConfigDialog.rateLimits.test.ts` | Dialog draft/Save/status behavior tests. |
| `.changeset/per-model-tpm-rpm-controls.md` | User-facing release note (minor). |

### 10.2 Modified Files

| Path | Change |
| --- | --- |
| `src/shared/apiTypes.ts` | Add `tpm`/`rpm` to `ModelsConfigModel`; add limits status and structured error types; extend `ModelsConfigSaveResponse`. |
| `src/shared/federatedRoutes.ts` | Add `GET /models-config/limits` to `FEDERATED_HTTP_ROUTES`. |
| `src/server/models/modelsConfigService.ts` | Pi-compatible read, shape guard, limits extraction, atomic write, serialized save chain, narrow refresh validation, publication, status, connection-test completion adapter, logger. |
| `src/server/models/modelsConfigService.test.ts` | Update existing service fakes and save-response assertions for the additive revision and refresh contracts. |
| `src/server/models/modelsConfigRoutes.ts` | Add limits status route and structured error/status mapping. |
| `src/server/sessiond.ts` | Create owner; pass to service, sessions, speech polishing; initialize at startup; dispose at shutdown. |
| `src/server/sessiond/sessionProxyRoutes.ts` | Proxy the new local sidecar route. |
| `src/server/sessiond/sessionProxyRoutes.test.ts` | Cover the new proxy route. |
| `src/server/app.remoteProxy.test.ts` | Extend federated-route coverage for the limits sidecar. |
| `src/server/sessions/piSessionService.ts` | Add optional `modelRateLimitOwner` dependency; wrap `result.session.agent.streamFunction` and publish the wrapped function through `UtilityModelExtensionRuntimeRefs`. |
| `src/server/sessions/piSessionService.promptQueue.test.ts` | Update the `createDefaultRuntimeFactory` call site for the optional owner parameter. |
| `src/client/src/api/parsers.ts` | Typed `tpm`/`rpm` parsing; limits status, save revision, and structured error parsers. |
| `src/client/src/api/parsers.modelsConfig.test.ts` | Extend model-config parser coverage for invalid-value preservation and structured responses. |
| `src/client/src/api/clients.ts` | `limitsStatus`; structured `save` error handling. |
| `src/client/src/api.ts` | Re-export new shared types used by the dialog. |
| `src/client/src/components/models/modelsConfigDraft.ts` | Draft identity, derivation, apply, reconcile, invalid lookup helpers. |
| `src/client/src/components/models/modelsConfigDraft.test.ts` | Extend with rate-limit draft tests, including pruning an orphan draft after model-ID rename or deletion. |
| `src/client/src/components/ModelsConfigDialog.ts` | Rate limits section, drafts, status, Save gating, error mapping. |
| `src/client/src/components/ModelsConfigDialog.test.ts` | Keep existing dialog stubs compatible with the optional limits-status API dependency. |
| `src/client/src/api/clients.test.ts` | Extend with limits status, save revision, and structured error client tests. |
| `src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | Keep the dialog wiring covered. |
| `docs/config.md` | Document the GUI workflow, field semantics, rolling window, cancellation, and restart requirement. |
| `docs/config.html` | Synchronize the same user-visible guidance. |

### 10.3 Integration Hook Order

`createDefaultRuntimeFactory` in `src/server/sessions/piSessionService.ts`
(`createDefaultRuntimeFactory` at line 1013, factory body around line 1024):

```ts
const result = await sdk.createFromServices({ ... });

const delegateStreamFunction = result.session.agent.streamFunction;
const limitedStreamFunction = rateLimitOwner === undefined
  ? delegateStreamFunction
  : wrapModelStream(rateLimitOwner, delegateStreamFunction);
result.session.agent.streamFunction = limitedStreamFunction;
runtimeRefs.streamFunction = limitedStreamFunction;

return { ...result, services, diagnostics: services.diagnostics };
```

Order and coverage requirements:

1. Wrap after `createFromServices` returns and after `runtimeRefs.settingsManager`
   is assigned, and before the factory returns. No model call can occur before the
   factory returns.
2. Pi reads `agent.streamFunction` at call time in `runAgentLoop` and in
   `_runDefaultCompaction`/branch-summary paths, so replacing the property covers
   interactive prompts, tool-loop continuations, follow-ups, steering, spawned
   sessions, automatic/manual compaction, and ordinary-model fallback.
3. `runtimeRefs.streamFunction` receives the same wrapped function, covering
   utility-model compaction and branch summaries and session-name generation
   (`maybeGenerateSessionName` around line 5050) and utility fallback candidates.
4. `AgentSessionRuntime.switchSession`, `fork`, and rebind call the factory again,
   producing a freshly wrapped stream function for the replacement session. No
   extra rebind hook is required.
5. The shared `ModelRuntime` is never wrapped. `ModelRuntime.streamSimple`,
   `ModelRuntime.completeSimple`, and provider composition remain untouched.
6. Session naming, compaction, branch summaries, and utility fallback each charge
   the actual model argument used for that call.
7. Speech polishing receives
   `modelRuntime: { completeSimple: wrapModelCompletion(rateLimits, (model, context, options) => auth.runtime.completeSimple(model, context, options)) }`.
8. Connection checks receive the same `wrapModelCompletion` treatment around the
   isolated runtime's `completeSimple`.
9. The owner is shared by all of the above because it is created once in
   `createRuntime()` and injected into the service, `PiSessionService`, speech
   polishing, and the connection-test path.

Covered call surfaces and their single integration point:

| Call surface | Integration point |
| --- | --- |
| Interactive prompts, tool-loop continuations, follow-ups, steering, spawned sessions | `result.session.agent.streamFunction` |
| Compaction, branch summaries, ordinary-model fallback | Same property, read at call time by Pi |
| Utility-model compaction and branch summaries | `runtimeRefs.streamFunction` |
| Session naming and utility fallback candidates | `session.agent.streamFunction` and `refs.streamFunction`, keyed by the actual candidate model |
| Speech-input polishing | Injected `completeSimple` adapter |
| Models dialog connection checks | Completion adapter around the isolated test runtime |

Not charged: model discovery, catalog refresh, authentication, transcription/speech
transport, deferred-result retrieval/cancellation, and extension calls that bypass
these interfaces.

---

## 11. Test Strategy and Fixtures

### 11.1 Test Layers

Use the repository testing guide. Prefer pure helper/service tests, then adapter
tests, then route contract tests, then focused integration tests. Dialog behavior
tests use the existing `@vitest-environment jsdom` docblock with real DOM input and
click events plus `await element.updateComplete`. Do not use TemplateResult handler
extraction to claim layout, focus, or accessibility coverage, and do not add a new
DOM dependency or vitest environment.

### 11.2 Named Test Matrix

| Area | Test file | Required coverage |
| --- | --- | --- |
| Shared values | `src/shared/modelRateLimits.test.ts` | Omitted, `0`, positive, negative, fraction, `NaN`, `Infinity`, unsafe integer, string, boolean, `null`, object; draft text canonical/blank/`+5`/`007`/`1e3`/`1.5`/`0x10`/`1_000`/unsafe; all four terminal counters and invalid-counter zeroing; `totalTokens` never added; no `NaN`/negative result. |
| Parser dialect | `src/server/models/modelsJsonParser.test.ts` | BOM; `//` comments; comment markers inside strings; escaped quotes; trailing commas in objects and arrays with whitespace/newlines; duplicate keys last-wins; block comments rejected; `#` comments rejected; invalid JSON rejected with `ModelsJsonParseError`. |
| Extraction | `src/server/rateLimits/modelRateLimitConfig.test.ts` | Fields only on explicit `models[]`; root/provider/`modelOverrides` `tpm`/`rpm` ignored and preserved; per-provider/per-model isolation; collision-safe identity (`a/b` + `c` vs `a` + `b/c`); duplicate IDs last-entry wins including omitted dimension on the last entry; invalid value on a shadowed duplicate rejects the snapshot; all errors collected with provider/modelId/occurrence/field/reason; ids with leading/trailing whitespace remain distinct. |
| Owner semantics | `src/server/rateLimits/modelRateLimitOwner.test.ts` | Fake clock: both-disabled immediate admit; RPM equality (`rpm = 10` admits 10, 11th waits); TPM equality; request and token expiry at exactly 60,000 ms and 59,999 ms; different timestamps per dimension; all four counters; overshoot by first and concurrent calls; disabled dimensions independent; multiple waiters FIFO; cancelled head does not starve the next; unrelated model progresses; config raise/disable wakes; config lower lengthens; usage preserved across toggle/provider edit; remove model/provider does not cancel work or retarget; exactly one timer per blocked identity and zero after drain; `completeCall` releases `inFlight`; dispose settles waiters and clears timers; blocked admission returns the structured error without queueing; `pruneIdleEntries` keeps states with waiters/history/in-flight. |
| Adapters | `src/server/rateLimits/modelRateLimitAdapters.test.ts` | Async-iteration event order; `.result()`-only consumer gets the terminal message while the caller never iterates; usage recorded exactly once before the terminal event/result is forwarded; duplicate terminal events accounted once; delegate throws synchronously; delegate rejects; stream ends without terminal; pre-dispatch abort makes no delegate call and no RPM charge; blocked admission produces the `MODEL_RATE_LIMITS_BLOCKED` terminal whose full message does not match Pi's retry classifier; delegate options forwarded unchanged; double-wrap guard returns the delegate; completion adapter resolves usage-recorded message, resolves aborted/blocked terminals, and rejects delegate failures after one `completeCall`. |
| Pi compatibility | `src/server/rateLimits/modelRateLimitPiCompatibility.test.ts` | Section 4.4 items 1-7 using `ModelRuntime.create` with `allowModelNetwork: false` and temp fixture files. |
| Config lifecycle | `src/server/models/modelsConfigService.rateLimits.test.ts` | Missing file -> empty document and `missing-file` source; parse failure -> structured error with no empty fallback and no write; invalid limits -> read returns the document while publish is rejected; save shape/limits rejection; save guard `MODELS_CONFIG_UNREADABLE`; atomic write uses a sibling temp file and rename, preserves an existing restricted mode such as `0600`, follows a symlink to update its effective target, rejects hard-linked targets without creating a temp file, and asserts no temp remains on failure; persist failure keeps active limits; refresh failure reports `persisted: true` and keeps last-known-good; refresh success publishes a higher revision and wakes waiters; serialized saves cannot publish older over newer; connection test uses saved limits and does not publish draft values; `initialize` never throws. |
| Routes | `src/server/models/modelsConfigRoutes.test.ts` | Every status/code in Section 8.1; `file`, `provider`, `modelId`, `field`, `occurrence`, `persisted` fields; `GET /models-config` still returns a bare document on success; sidecar shape. |
| Proxy | `src/server/sessiond/sessionProxyRoutes.test.ts` | `GET /api/models-config/limits` proxies; existing models-config routes unchanged. |
| Federated routes | `src/server/app.remoteProxy.test.ts` | `GET /models-config/limits` is in `FEDERATED_HTTP_ROUTES` exactly once and is proxied to remote machines. |
| Session integration | `src/server/sessions/piSessionService.rateLimits.test.ts` | Two independently created sessions share one model budget; interactive stream call goes through the wrapper exactly once; naming, compaction/branch-summary utility paths, and utility fallback each charge the actual candidate model; runtime replacement re-wraps and does not double-wrap; session dispose aborts queued waiters; blocked owner fails sessions closed with the structured terminal. |
| Speech polishing | `src/server/speechInput/speechInputPolishingService.rateLimits.test.ts` | Polishing charges the actual candidate model through the injected completion adapter; abort during queue wait preserves the route deadline and does not dispatch later. |
| Client API | `src/client/src/api/clients.test.ts` and parser tests | Typed `tpm`/`rpm` parse plus invalid-value preservation; strict limits-status parser (unknown keys, wrong version, bad admission/source); save revision parsing; structured save error mapping with fallback to `error`; `limitsStatus` 404 surface; nested-deployment URL encoding for the new path. |
| Client drafts | `src/client/src/components/models/modelsConfigDraft.test.ts` | Key encoding collision cases; derivation from valid/invalid stored values; apply valid/invalid/blank/`0`; set/delete field; reconcile on add/delete/rename including deleting an earlier duplicate and shifting later occurrences; `firstInvalidRateLimitDraft`. |
| Dialog behavior | `src/client/src/components/ModelsConfigDialog.rateLimits.test.ts` (`@vitest-environment jsdom`) | Mount the real element with a stub `modelsApi`, dispatch real `input` and `click` events, and await `updateComplete`: section presence/labels/placeholders; valid set/change/clear updates the Save payload; invalid input blocks Save and shows the field error; invalid draft on another model blocks Save after navigation; loaded invalid stored value blocks Save; load failure disables Save; blocked-admission status banner; last-known-good status banner; status 404 tolerated; machine switch clears drafts and ignores stale async results; structured save error maps code, field, and reason to the field; Test remains usable with an invalid draft; close/reopen restores saved values and leaves a second model unchanged. Geometry and keyboard-focus order are out of scope here and belong to Section 11.4. |
| App wiring | `src/client/src/components/PiWebUiApp.modelsConfig.test.ts` | Existing dialog open/close and machine targeting stay green. |

### 11.3 Deterministic Fixtures

1. `src/server/rateLimits/modelRateLimitTestSupport.ts` provides:
   - `createFakeModelRateLimitClock()` with `now()`, `advance(ms)`,
     `schedule(delayMs, callback)`, and `pendingTimerCount()`. `advance` moves the
     clock, fires due timers once in scheduled order, and never uses real timers.
   - `fixtureTerminalMessage(overrides)` building a complete `AssistantMessage`.
   - `createControllableStream()` returning `{ stream, push, end, error }` for
     delegate streams and helper `deferred<T>()` promises.
   - `fixtureLimits(tpm?, rpm?)` and `fixtureIdentity(provider, modelId)`.
2. Filesystem fixtures use `mkdtemp` under `os.tmpdir()` and are removed in
   `afterEach`, matching `modelsConfigService.test.ts`.
3. Pi compatibility fixtures are written with exact text (including BOM and `//`
   comments) and read back to prove no rewrite.
4. No test uses wall-clock sleeps, real `setTimeout` for limiter timing, or network
   access.
5. `ModelsConfigDialog.rateLimits.test.ts` uses the jsdom environment for real
   DOM interaction (events, inputs, `updateComplete`). It must not attempt layout,
   clipping, or focus-geometry assertions that jsdom cannot evaluate.

### 11.4 Browser Geometry Verification

This is a required implementation-time verification, not a committed Vitest test.
Follow the `probe-narrow-lit-layout-with-chromium-cdp` procedure:

1. Create a temporary HTML fixture under `src/client` that imports the real
   `ModelsConfigDialog`, sets a stub `modelsApi` with a valid document containing a
   model with `tpm`/`rpm`, mounts it, waits for two animation frames, and writes a
   JSON measurement object to a stable result element.
2. Serve it with `npm run dev:client -- --port <unused> --strictPort`.
3. Launch headless Chromium with a remote-debugging port and use CDP
   `Emulation.setDeviceMetricsOverride` before navigation at each viewport.
4. Viewports: desktop `1440x900` and mobile `390x844` (matching
   `scripts/capture-screenshots.mjs` conventions), plus a `700x844` check at the
   media-query boundary and a `701x844` check just above it.
5. Assert:
   - `window.innerWidth` equals the requested width;
   - document and dialog scroll widths do not exceed their client widths;
   - the `.rate-limits-section` exists and its top is greater than or equal to the
     context/max-output row bottom and its bottom is less than or equal to the cost
     section top;
   - desktop (above 700): the TPM input's right edge is less than or equal to the
     RPM input's left edge and their vertical ranges overlap (two columns);
   - mobile (at or below 700): the RPM input's top is greater than or equal to the
     TPM input's bottom (one column);
   - both inputs stay inside the dialog's left/right edges;
   - the `Rate limits` label, field labels, and any `.field-error` element have
     `scrollWidth <= clientWidth` (no clipping or overlap);
   - keyboard order: after focusing `#model-tpm` and dispatching Tab, focus reaches
     `#model-rpm`, then the first cost input.
6. Remove the temporary fixture, CDP script, browser profile, and logs; stop the
   temporary Vite process; confirm no temporary file remains in `git status`.
7. Record the measurement JSON and screenshots in the implementation handoff as
   evidence.

### 11.5 Commands and Sequence

1. Focused tests first, in this order:
   - `npm test -- --run src/shared/modelRateLimits.test.ts`
   - `npm test -- --run src/server/models/modelsJsonParser.test.ts`
   - `npm test -- --run src/server/rateLimits/modelRateLimitConfig.test.ts`
   - `npm test -- --run src/server/rateLimits/modelRateLimitOwner.test.ts`
   - `npm test -- --run src/server/rateLimits/modelRateLimitAdapters.test.ts`
   - `npm test -- --run src/server/rateLimits/modelRateLimitPiCompatibility.test.ts`
   - `npm test -- --run src/server/models/modelsConfigService.rateLimits.test.ts`
   - `npm test -- --run src/server/models/modelsConfigRoutes.test.ts`
   - `npm test -- --run src/server/sessions/piSessionService.rateLimits.test.ts`
   - `npm test -- --run src/client/src/components/models/modelsConfigDraft.test.ts`
   - `npm test -- --run src/client/src/components/ModelsConfigDialog.rateLimits.test.ts`
   - `npm test -- --run src/client/src/api/clients.test.ts`
2. Then `npm run typecheck`, `npx eslint` on changed files, and
   `npm run verify:fast` for routine cross-cutting verification.
3. Run `npm run verify` and the required frontier implementation audit before the
   delivery gate. Do not run a full suite alongside heavy child work.
4. No merge into the delivery target occurs without the user's later delivery
   choice.

---

## 12. Operational Rollout

1. **Manual restart required.** Installing this implementation changes
   `src/server/sessiond.ts`, session runtime ownership, and code paths loaded only
   by the session daemon. After installation the user must manually restart
   `pi-webui-sessiond.service`. Do not automatically restart the running daemon
   during development. Later saves of limit values are live and require no restart.
2. UI-only changes use the existing `pi-webui-ui-dev.service` autoreload path.
3. A daemon restart discards rolling histories. A web/API restart does not.
4. External edits to `models.json` require a daemon restart to guarantee limit
   reload; no file watcher is introduced. Saving through the dialog activates
   accepted limits immediately.
5. Documentation: update `docs/config.md` and `docs/config.html` with the GUI
   workflow, field semantics (actual terminal usage, rolling 60 seconds, queueing,
   cancellation, overshoot), the daemon-restart requirement for installation and
   external edits, and a short note that limits are local to the daemon and active
   profile. Keep `README.md` unchanged unless its quick-start path changes. Add FAQ
   troubleshooting only if operator recovery needs it.
6. Release note: add `.changeset/per-model-tpm-rpm-controls.md` with
   `"@hyperdreamer/pi-webui": minor`. Do not edit `CHANGELOG.md` manually.

---

## 13. Acceptance Criteria

1. `tpm` and `rpm` round-trip through read, GUI edit, Save, and Pi loading, and
   unknown fields remain intact; two assertions in
   `src/server/rateLimits/modelRateLimitPiCompatibility.test.ts` prove model
   behavior is identical with and without the fields.
2. Calls to one provider/model identity share one budget across sessions, spawned
   sessions, and utility operations; different model IDs and the same ID under a
   different provider are independent.
3. Rolling-window semantics match Section 5.5 exactly: strict `<` admission, expiry
   at exactly 60,000 ms, no reservation, no per-delta counting, overshoot allowed.
4. `completeCall` records terminal usage once, before the terminal event/result is
   forwarded, for successful, failed, and aborted calls, with invalid counters
   contributing zero.
5. Waiting never spends a RPM unit or invokes a delegate; cancelling the head or any
   waiter removes it without a charge; dispatch rechecks cancellation; shutdown and
   session disposal leave no waiters, timers, or listeners.
6. Raising or disabling a limit wakes eligible waiters immediately; lowering a limit
   lengthens waits; recent usage survives limit changes.
7. Persist, refresh-validate, publish, and wake happen in order; a persistence or
   refresh failure never reports success and never activates an invalid document as
   unlimited; a daemon with no valid snapshot fails admission closed with the
   structured error and recovers through a successful Save.
8. The dialog shows the Rate limits section between Context/Max output and Cost,
   loads saved values, sets/changes/clears them, persists them with the existing
   Save, and shows them again after closing and reopening.
9. An invalid rate-limit draft anywhere in the document blocks Save; an unreadable
   document is reported and cannot be replaced with an empty document, including by
   a stale client.
10. Structured API and dialog errors name the code, file, provider, model ID, field,
    occurrence, and reason where applicable.
11. `GET /models-config` remains a bare document; the limits sidecar is additive;
    old clients and old remote daemons remain safe in both compatibility
    directions.
12. All named test files in Section 11.2 pass; the browser geometry probe in
    Section 11.4 records passing measurements at all viewports; `npm run verify`
    passes.
13. `docs/config.md`, `docs/config.html`, and the Changeset are updated; the spec's
    manual `pi-webui-sessiond.service` restart note is present in the operational
    documentation.
14. No file outside this specification's ownership list is changed.

---

## 14. Open Residual Risks

1. **Actual usage is not a hard ceiling.** Overshoot is accepted by design. A
   provider that reports usage late or not at all can let more tokens through than
   configured.
2. **Provider-side quotas still apply.** This is local throttling, not a
   reconstruction of provider accounts, hidden retry traffic, or rate-limit
   responses.
3. **Queue wait can be unbounded for ordinary sessions.** There is no new arbitrary
   queue timeout; a sustained usage stream above `tpm` can keep later calls waiting
   until usage ages out.
4. **Duplicate model IDs are degenerate for editing.** The last entry owns limits
   and the dialog keys drafts by occurrence; editing shadows is possible but not
   encouraged.
5. **External edits need a restart.** Limits loaded at startup are not
   automatically reloaded from disk.
6. **Block comments are rejected.** This matches Pi 0.85.1. If a future Pi release
   accepts block comments, the vendored parser must be updated with parity tests.
7. **Rolling mixed versions.** A new UI with an old remote daemon can store and
   display limits without enforcement until that daemon is upgraded and restarted.
8. **Hung providers retain in-flight state.** A delegate that never terminates keeps
   one `inFlight` count and its identity state until the process exits; memory stays
   bounded by active identities.
9. **Mutable maps are frozen by contract, not by the type system.** Server maps are
   readonly by type and must never be mutated after publication; tests assert
   behavior rather than runtime freezing.
10. **The dialog cannot repair an unparseable file in place.** The supported
    recovery is an external fix followed by Reload and Save, or a daemon restart.
11. **Hard-linked models files are not supported for atomic persistence.** Saves reject
    a target with multiple directory links rather than silently diverging one link;
    symlinked paths are resolved and remain supported.
12. **The requests-per-minute field is `rpm`, not `prm`.** This amendment (2026-09-14)
    corrects the original spelling, which was carried over verbatim from the user's
    first phrasing and recorded in the design's terminology table. Every field key,
    type member, message, label, DOM id, test, and document now uses `rpm`/`RPM`;
    `tpm` is unchanged. The shipped implementation had not been released, so no
    migration is required. The design, plan, and execution-graph artifacts retain the
    original spelling as historical run records.

---

## 15. Sign-Off

This technical specification was approved by the user on 2026-09-13. The frontier
specification review passed with no blocking findings, and its nonblocking
recommendations are incorporated in this document. Implementation follows the
repository testing, architecture, documentation, and Changeset skills, and
installation requires the manual `pi-webui-sessiond.service` restart stated in
Section 12.
