# Per-Model TPM and PRM Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional per-model `tpm`/`prm` limits stored on `models.json` entries, enforced by one daemon-owned rolling-window limiter across every model-call surface, editable in the existing Models settings dialog.

**Architecture:** A pure shared value module and a vendored Pi-compatible `models.json` text parser feed a snapshot extractor that maps exact `(provider, modelId)` identities to enabled limits. A single process-wide limiter owner (injected monotonic clock, FIFO waiters, per-identity timers) is wrapped around Pi's stream function and completion functions by narrow adapters. `ModelsConfigService` validates, atomically persists, narrow-refresh-validates, then publishes snapshots; the dialog edits drafts and gates Save; a sidecar route reports limiter status.

**Tech Stack:** TypeScript (strict, ES2022, Node >= 22.19), Fastify, Lit (client dialog), Vitest (jsdom for dialog tests), `@earendil-works/pi-ai` / `@earendil-works/pi-agent-core` 0.85.1 types, `@earendil-works/pi-coding-agent` `ModelRuntime`.

## Global Constraints

- Rolling window is exactly 60,000 ms on a monotonic clock; entries expire when `timestamp <= now - 60000`; admission uses strict `<` against retained request count and retained token sum.
- TPM charges actual terminal usage `input + output + cacheRead + cacheWrite`; `totalTokens` is never added.
- PRM counts admission to one underlying model-call dispatch; a thrown error without usage still consumes its dispatched unit; pre-dispatch aborts consume nothing.
- `tpm` and `prm` are optional non-negative safe integers stored only on explicit `providers[provider].models[]` entries; omission or `0` independently disables a dimension.
- Identity is the exact provider string plus the exact model ID string; nested maps only, never a delimiter-joined key.
- No new runtime dependencies; the `models.json` parser is vendored and matches Pi 0.85.1 (optional BOM, `//` line comments, trailing commas, no block comments).
- Pi 0.85.1 compatibility only: do not patch installed Pi, fork the SDK, change provider request payloads, or wrap the shared `ModelRuntime`.
- Unknown document, provider, and model fields survive read, edit, save, and Pi loading; root/provider/`modelOverrides` `tpm`/`prm` stay opaque and never activate a limit.
- `models.json` is written as `JSON.stringify(document, null, 2)` plus a trailing newline.
- `GET /models-config` keeps returning the bare document; the sidecar is `GET /models-config/limits`; no capability flag is added.
- Blocked admission uses code `MODEL_RATE_LIMITS_BLOCKED`; its message starts `Model requests are blocked because the model configuration is invalid.`
- The dialog connection test keeps its existing 20-second timeout; unsaved drafts never replace live limits.
- TypeScript floor: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`; Node >= 22.19.
- Tests use Vitest; dialog behavior tests keep the existing `@vitest-environment jsdom` docblock; no new DOM test dependency or vitest environment; limiter tests use fake clocks and never wall-clock sleeps, real timers, or network.
- Dialog layout and keyboard-focus geometry is verified only with the Chromium CDP probe, never with jsdom.
- Release note is `.changeset/per-model-tpm-prm-controls.md` with `"@hyperdreamer/pi-webui": minor`; never edit `CHANGELOG.md` manually.
- Installing this change requires one manual `pi-webui-sessiond.service` restart; later limit saves are live; external file edits require a daemon restart.
- `PI_WEBUI_DATA_DIR` state and `PI_WEBUI_CONFIG` config remain as documented; `models.json` in the active agent profile is the only storage for these values.

## Task 1: Shared rate-limit value contract

**Implementer tier:** Standard

**Files:**

- Create: `src/shared/modelRateLimits.ts`
- Test: `src/shared/modelRateLimits.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `MODEL_RATE_LIMIT_FIELDS: readonly ["tpm", "prm"]`;
  `type ModelRateLimitField = "tpm" | "prm"`;
  `MODEL_RATE_LIMIT_WINDOW_MS: 60_000`;
  `type ModelRateLimitInvalidReason = "not-a-number" | "not-finite" | "not-an-integer" | "negative" | "unsafe-integer" | "missing-model-id"`;
  `type ModelRateLimitInvalidFieldReason = Exclude<ModelRateLimitInvalidReason, "missing-model-id">`;
  `interface ModelRateLimitValues { tpm?: number; prm?: number }`;
  `type ModelRateLimitFieldParse = { ok: true; value: number | undefined } | { ok: false; reason: ModelRateLimitInvalidFieldReason }`;
  `parseModelRateLimitStoredValue(value: unknown): ModelRateLimitFieldParse`;
  `parseModelRateLimitDraftText(text: string): ModelRateLimitFieldParse`;
  `modelRateLimitValuesFromEntry(entry: Record<string, unknown>): { ok: true; values: ModelRateLimitValues } | { ok: false; field: ModelRateLimitField; reason: ModelRateLimitInvalidFieldReason }`;
  `modelRateLimitFieldMessage(field: ModelRateLimitField, reason: ModelRateLimitInvalidReason): string`;
  `sumModelTerminalTokens(usage: unknown): number`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  MODEL_RATE_LIMIT_FIELDS,
  MODEL_RATE_LIMIT_WINDOW_MS,
  modelRateLimitFieldMessage,
  modelRateLimitValuesFromEntry,
  parseModelRateLimitDraftText,
  parseModelRateLimitStoredValue,
  sumModelTerminalTokens,
} from "./modelRateLimits";

describe("model rate limit values", () => {
  it("exposes the two fields and the rolling window", () => {
    expect(MODEL_RATE_LIMIT_FIELDS).toEqual(["tpm", "prm"]);
    expect(MODEL_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("accepts omitted, zero, and positive safe integers and reports each rejection reason", () => {
    expect(parseModelRateLimitStoredValue(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitStoredValue(0)).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitStoredValue(-0)).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitStoredValue(90_000)).toEqual({ ok: true, value: 90_000 });
    expect(parseModelRateLimitStoredValue(-1)).toEqual({ ok: false, reason: "negative" });
    expect(parseModelRateLimitStoredValue(1.5)).toEqual({ ok: false, reason: "not-an-integer" });
    expect(parseModelRateLimitStoredValue(Number.NaN)).toEqual({ ok: false, reason: "not-finite" });
    expect(parseModelRateLimitStoredValue(Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: "not-finite" });
    expect(parseModelRateLimitStoredValue(Number.MAX_SAFE_INTEGER + 1)).toEqual({ ok: false, reason: "unsafe-integer" });
    expect(parseModelRateLimitStoredValue("90")).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue(true)).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue(null)).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue({})).toEqual({ ok: false, reason: "not-a-number" });
    expect(parseModelRateLimitStoredValue([])).toEqual({ ok: false, reason: "not-a-number" });
  });

  it("parses only canonical non-negative decimal draft text", () => {
    expect(parseModelRateLimitDraftText("")).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitDraftText("   ")).toEqual({ ok: true, value: undefined });
    expect(parseModelRateLimitDraftText("0")).toEqual({ ok: true, value: 0 });
    expect(parseModelRateLimitDraftText(" 100000 ")).toEqual({ ok: true, value: 100_000 });
    for (const text of ["+5", "-0", "007", "1e3", "1.5", "0x10", "1_000", "1 000", "abc", "-5"]) {
      expect(parseModelRateLimitDraftText(text)).toEqual({ ok: false, reason: "not-a-number" });
    }
    expect(parseModelRateLimitDraftText(String(Number.MAX_SAFE_INTEGER + 1))).toEqual({ ok: false, reason: "unsafe-integer" });
  });

  it("keeps only positive values and reports the first invalid field in field order", () => {
    expect(modelRateLimitValuesFromEntry({})).toEqual({ ok: true, values: {} });
    expect(modelRateLimitValuesFromEntry({ tpm: 0, prm: 5 })).toEqual({ ok: true, values: { prm: 5 } });
    expect(modelRateLimitValuesFromEntry({ tpm: 9, prm: 5 })).toEqual({ ok: true, values: { tpm: 9, prm: 5 } });
    expect(modelRateLimitValuesFromEntry({ prm: "5" })).toEqual({ ok: false, field: "prm", reason: "not-a-number" });
    expect(modelRateLimitValuesFromEntry({ tpm: -1, prm: "5" })).toEqual({ ok: false, field: "tpm", reason: "negative" });
  });

  it("sums only the four terminal counters and never adds totalTokens", () => {
    expect(sumModelTerminalTokens({ input: 10, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 9_999 })).toBe(19);
    expect(sumModelTerminalTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 })).toBe(0);
    expect(sumModelTerminalTokens({ input: -5, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: "3" })).toBe(0);
    expect(sumModelTerminalTokens({ output: 7 })).toBe(7);
    expect(sumModelTerminalTokens(undefined)).toBe(0);
    expect(sumModelTerminalTokens(null)).toBe(0);
    expect(sumModelTerminalTokens("nope")).toBe(0);
  });

  it("returns stable field messages", () => {
    expect(modelRateLimitFieldMessage("tpm", "not-a-number")).toBe("Tokens per minute must be a whole number.");
    expect(modelRateLimitFieldMessage("prm", "not-a-number")).toBe("Requests per minute must be a whole number.");
    expect(modelRateLimitFieldMessage("tpm", "negative")).toBe("Tokens per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("prm", "not-finite")).toBe("Requests per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("tpm", "unsafe-integer")).toBe("Tokens per minute must be a non-negative whole number.");
    expect(modelRateLimitFieldMessage("prm", "missing-model-id")).toBe("Set a Model ID before setting rate limits.");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/shared/modelRateLimits.test.ts`
Expected: FAIL, `Cannot find module './modelRateLimits'` or equivalent resolution error.

- [ ] **Step 3: Write the minimal implementation**

```ts
export const MODEL_RATE_LIMIT_FIELDS = ["tpm", "prm"] as const;
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
  prm?: number;
}

export type ModelRateLimitFieldParse =
  | { ok: true; value: number | undefined }
  | { ok: false; reason: ModelRateLimitInvalidFieldReason };

const TERMINAL_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Validates one stored `tpm`/`prm` value from models.json. */
export function parseModelRateLimitStoredValue(value: unknown): ModelRateLimitFieldParse {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number") return { ok: false, reason: "not-a-number" };
  if (!Number.isFinite(value)) return { ok: false, reason: "not-finite" };
  if (!Number.isInteger(value)) return { ok: false, reason: "not-an-integer" };
  if (value < 0) return { ok: false, reason: "negative" };
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "unsafe-integer" };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Validates raw dialog input text. Blank clears the field. */
export function parseModelRateLimitDraftText(text: string): ModelRateLimitFieldParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^(0|[1-9][0-9]*)$/u.test(trimmed)) return { ok: false, reason: "not-a-number" };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "unsafe-integer" };
  return { ok: true, value: value === 0 ? 0 : value };
}

/** Returns only enabled (positive) dimensions; omitted and 0 are absent. */
export function modelRateLimitValuesFromEntry(
  entry: Record<string, unknown>,
): { ok: true; values: ModelRateLimitValues } | { ok: false; field: ModelRateLimitField; reason: ModelRateLimitInvalidFieldReason } {
  const values: ModelRateLimitValues = {};
  for (const field of MODEL_RATE_LIMIT_FIELDS) {
    const parsed = parseModelRateLimitStoredValue(entry[field]);
    if (!parsed.ok) return { ok: false, field, reason: parsed.reason };
    if (parsed.value !== undefined && parsed.value > 0) values[field] = parsed.value;
  }
  return { ok: true, values };
}

/** Stable user-facing message shared by API errors and dialog field errors. */
export function modelRateLimitFieldMessage(field: ModelRateLimitField, reason: ModelRateLimitInvalidReason): string {
  if (reason === "missing-model-id") return "Set a Model ID before setting rate limits.";
  const label = field === "tpm" ? "Tokens per minute" : "Requests per minute";
  if (reason === "not-a-number") return `${label} must be a whole number.`;
  return `${label} must be a non-negative whole number.`;
}

/** Sums terminal usage counters; invalid or missing counters contribute zero. */
export function sumModelTerminalTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return 0;
  const record = usage as Record<string, unknown>;
  let sum = 0;
  for (const field of TERMINAL_USAGE_FIELDS) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/shared/modelRateLimits.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelRateLimits.ts src/shared/modelRateLimits.test.ts
git commit -m "feat(models): add shared model rate limit value contract"
```

## Task 2: Pi-compatible models.json parser

**Implementer tier:** Standard

**Files:**

- Create: `src/server/models/modelsJsonParser.ts`
- Test: `src/server/models/modelsJsonParser.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `class ModelsJsonParseError extends SyntaxError` with `constructor(message: string, options?: { cause?: unknown })`;
  `stripModelsJsonBom(content: string): string`;
  `stripModelsJsonComments(input: string): string`;
  `parseModelsJsonText(content: string): unknown`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  ModelsJsonParseError,
  parseModelsJsonText,
  stripModelsJsonBom,
  stripModelsJsonComments,
} from "./modelsJsonParser";

describe("Pi-compatible models.json parser", () => {
  it("strips a leading BOM only", () => {
    expect(stripModelsJsonBom("\uFEFF{}")).toBe("{}");
    expect(stripModelsJsonBom("{}")).toBe("{}");
  });

  it("strips line comments outside string literals without touching string content", () => {
    expect(stripModelsJsonComments('{ // note\n "a": "http://x//y", // tail\n "b": 1\n}'))
      .toBe('{ \n "a": "http://x//y", \n "b": 1\n}');
  });

  it("removes trailing commas before objects and arrays including newlines", () => {
    expect(stripModelsJsonComments('{"a": [1, 2,],}')).toBe('{"a": [1, 2]}');
    expect(stripModelsJsonComments('{"a": [\n1,\n2,\n],\n}')).toBe('{"a": [\n1,\n2\n]\n}');
  });

  it("parses BOM, comments, and trailing commas like Pi 0.85.1", () => {
    const text = '\uFEFF{ // provider list\n "providers": { "acme": { "models": [{ "id": "demo", },], }, },\n}';
    expect(parseModelsJsonText(text)).toEqual({ providers: { acme: { models: [{ id: "demo" }] } } });
  });

  it("keeps comment markers and escaped quotes inside strings", () => {
    expect(parseModelsJsonText('{"url": "https://example.test/a//b", "quote": "say \\"hi\\" // now"}'))
      .toEqual({ url: "https://example.test/a//b", quote: 'say "hi" // now' });
  });

  it("lets JSON.parse last-key-wins semantics apply to duplicate keys", () => {
    expect(parseModelsJsonText('{"id": "first", "id": "second"}')).toEqual({ id: "second" });
  });

  it("rejects block comments, hash comments, and non-JSON syntax with ModelsJsonParseError", () => {
    expect(() => parseModelsJsonText('{"a": 1 /* comment */}')).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText('# comment\n{"a": 1}')).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText("{a: 1}")).toThrow(ModelsJsonParseError);
    expect(() => parseModelsJsonText('{"a": 1,,}')).toThrow(ModelsJsonParseError);
  });

  it("preserves the original JSON.parse message on the wrapped error", () => {
    expect(() => parseModelsJsonText('{"a": }')).toThrow(/Unexpected|Expected|position/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/models/modelsJsonParser.test.ts`
Expected: FAIL, `Cannot find module './modelsJsonParser'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
/**
 * Pi 0.85.1 compatibility: optional leading BOM, `//` line comments, and
 * trailing commas are accepted; block comments and hash comments are not.
 * Mirrors `dist/utils/text.js` and `dist/utils/json.js` in the installed Pi.
 */
export class ModelsJsonParseError extends SyntaxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelsJsonParseError";
  }
}

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

export function parseModelsJsonText(content: string): unknown {
  const text = stripModelsJsonComments(stripModelsJsonBom(content));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ModelsJsonParseError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/models/modelsJsonParser.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/models/modelsJsonParser.ts src/server/models/modelsJsonParser.test.ts
git commit -m "feat(models): vendor Pi-compatible models.json parser"
```

## Task 3: Limits snapshot extraction and identity

**Implementer tier:** Standard

**Files:**

- Create: `src/server/rateLimits/modelRateLimitConfig.ts`
- Test: `src/server/rateLimits/modelRateLimitConfig.test.ts`

**Interfaces:**

- Consumes: `MODEL_RATE_LIMIT_FIELDS`, `modelRateLimitFieldMessage(field, reason)`, `modelRateLimitValuesFromEntry(entry)` from Task 1, with `ModelRateLimitValues = { tpm?: number; prm?: number }` and `ModelRateLimitInvalidFieldReason = "not-a-number" | "not-finite" | "not-an-integer" | "negative" | "unsafe-integer"`; `ModelsConfigDocument` from `src/shared/apiTypes.ts`.
- Produces: `interface ModelRateLimitIdentity { readonly provider: string; readonly modelId: string }`;
  `interface ModelRateLimitValidationError { provider: string; modelId: string; occurrence: number; field: ModelRateLimitField; reason: ModelRateLimitInvalidReason; message: string }`;
  `interface ModelRateLimitSnapshot { readonly limits: ReadonlyMap<string, ReadonlyMap<string, ModelRateLimitValues>> }`;
  `type ModelRateLimitExtraction = { ok: true; snapshot: ModelRateLimitSnapshot } | { ok: false; errors: readonly ModelRateLimitValidationError[] }`;
  `emptyModelRateLimitSnapshot(): ModelRateLimitSnapshot`;
  `extractModelRateLimits(document: ModelsConfigDocument): ModelRateLimitExtraction`;
  `modelRateLimitValuesFor(snapshot: ModelRateLimitSnapshot, identity: ModelRateLimitIdentity): ModelRateLimitValues | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { ModelsConfigDocument } from "../../shared/apiTypes";
import {
  emptyModelRateLimitSnapshot,
  extractModelRateLimits,
  modelRateLimitValuesFor,
} from "./modelRateLimitConfig";

const model = (id: string, limits: Record<string, unknown> = {}) => ({ id, ...limits });

describe("model rate limit extraction", () => {
  it("recognizes limits only on explicit models entries", () => {
    const document: ModelsConfigDocument = {
      tpm: 10,
      providers: {
        acme: {
          tpm: 20,
          prm: 30,
          modelOverrides: { demo: { tpm: 40, prm: 50 } },
          models: [model("demo", { tpm: 100, prm: 5 })],
        },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 100, prm: 5 });
    expect(extraction.snapshot.limits.size).toBe(1);
    expect(document.tpm).toBe(10);
    expect(document.providers?.["acme"]?.modelOverrides).toEqual({ demo: { tpm: 40, prm: 50 } });
  });

  it("keeps provider and model budgets independent with collision-safe identity", () => {
    const document: ModelsConfigDocument = {
      providers: {
        "a/b": { models: [model("c", { tpm: 7 })] },
        a: { models: [model("b/c", { prm: 3 })] },
        other: { models: [model("c", { tpm: 9 })] },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "a/b", modelId: "c" })).toEqual({ tpm: 7 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "a", modelId: "b/c" })).toEqual({ prm: 3 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "other", modelId: "c" })).toEqual({ tpm: 9 });
  });

  it("keeps ids with surrounding whitespace distinct", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("strict", { prm: 1 }), model(" strict", { prm: 2 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "strict" })).toEqual({ prm: 1 });
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: " strict" })).toEqual({ prm: 2 });
  });

  it("lets the last duplicate own both dimensions and drops omitted dimensions", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("demo", { tpm: 100, prm: 5 }), model("demo", { tpm: 300 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 300 });
  });

  it("drops every identity without an enabled dimension", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("plain"), model("zero", { tpm: 0, prm: 0 })] } },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(extraction.snapshot.limits.size).toBe(0);
    expect(emptyModelRateLimitSnapshot().limits.size).toBe(0);
  });

  it("rejects the whole snapshot when a shadowed duplicate is invalid", () => {
    const document: ModelsConfigDocument = {
      providers: { acme: { models: [model("demo", { tpm: "bad" }), model("demo", { tpm: 10 })] } },
    };

    expect(extractModelRateLimits(document)).toEqual({
      ok: false,
      errors: [{
        provider: "acme",
        modelId: "demo",
        occurrence: 0,
        field: "tpm",
        reason: "not-a-number",
        message: "Tokens per minute must be a whole number.",
      }],
    });
  });

  it("collects all errors in provider, entry, and field order", () => {
    const document: ModelsConfigDocument = {
      providers: {
        first: { models: [model("", { tpm: 1, prm: 2 }), model("b", { tpm: 1.5 })] },
        second: { models: [model("a", { prm: -1 })] },
      },
    };

    const extraction = extractModelRateLimits(document);

    expect(extraction.ok).toBe(false);
    if (extraction.ok) return;
    expect(extraction.errors.map(({ provider, modelId, occurrence, field, reason }) => ({ provider, modelId, occurrence, field, reason }))).toEqual([
      { provider: "first", modelId: "", occurrence: 0, field: "tpm", reason: "missing-model-id" },
      { provider: "first", modelId: "", occurrence: 0, field: "prm", reason: "missing-model-id" },
      { provider: "first", modelId: "b", occurrence: 0, field: "tpm", reason: "not-an-integer" },
      { provider: "second", modelId: "a", occurrence: 0, field: "prm", reason: "negative" },
    ]);
  });

  it("treats absent or malformed collections as no limits", () => {
    expect(extractModelRateLimits({})).toEqual({ ok: true, snapshot: { limits: new Map() } });
    expect(extractModelRateLimits({ providers: { acme: { models: "no" } } })).toEqual({ ok: true, snapshot: { limits: new Map() } });
    expect(extractModelRateLimits({ providers: { acme: { models: [null, { id: "demo", tpm: 5 }] } } }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitConfig.test.ts`
Expected: FAIL, `Cannot find module './modelRateLimitConfig'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { ModelsConfigDocument } from "../../shared/apiTypes.js";
import {
  MODEL_RATE_LIMIT_FIELDS,
  modelRateLimitFieldMessage,
  modelRateLimitValuesFromEntry,
  type ModelRateLimitField,
  type ModelRateLimitInvalidReason,
  type ModelRateLimitValues,
} from "../../shared/modelRateLimits.js";

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

export function emptyModelRateLimitSnapshot(): ModelRateLimitSnapshot {
  return { limits: new Map() };
}

export function extractModelRateLimits(document: ModelsConfigDocument): ModelRateLimitExtraction {
  const limits = new Map<string, Map<string, ModelRateLimitValues>>();
  const errors: ModelRateLimitValidationError[] = [];
  const providers = document.providers;
  if (providers === undefined || !isRecord(providers)) return { ok: true, snapshot: { limits } };

  for (const provider of Object.keys(providers)) {
    const providerRecord = providers[provider];
    if (!isRecord(providerRecord)) continue;
    const models = providerRecord["models"];
    if (!Array.isArray(models)) continue;

    let providerLimits = limits.get(provider);
    if (providerLimits === undefined) {
      providerLimits = new Map();
      limits.set(provider, providerLimits);
    }

    const occurrences = new Map<string, number>();
    for (const entry of models) {
      if (!isRecord(entry)) continue;
      const rawId = entry["id"];
      const modelId = typeof rawId === "string" ? rawId : "";
      const occurrence = occurrences.get(modelId) ?? 0;
      occurrences.set(modelId, occurrence + 1);

      if (modelId === "") {
        for (const field of MODEL_RATE_LIMIT_FIELDS) {
          if (entry[field] === undefined) continue;
          errors.push({ provider, modelId, occurrence, field, reason: "missing-model-id", message: modelRateLimitFieldMessage(field, "missing-model-id") });
        }
        continue;
      }

      const parsed = modelRateLimitValuesFromEntry(entry);
      if (!parsed.ok) {
        errors.push({ provider, modelId, occurrence, field: parsed.field, reason: parsed.reason, message: modelRateLimitFieldMessage(parsed.field, parsed.reason) });
        continue;
      }
      providerLimits.set(modelId, parsed.values);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const enabledLimits = new Map<string, Map<string, ModelRateLimitValues>>();
  for (const [provider, providerLimits] of limits) {
    const enabled = new Map<string, ModelRateLimitValues>();
    for (const [modelId, values] of providerLimits) {
      if (values.tpm !== undefined || values.prm !== undefined) enabled.set(modelId, values);
    }
    if (enabled.size > 0) enabledLimits.set(provider, enabled);
  }
  return { ok: true, snapshot: { limits: enabledLimits } };
}

export function modelRateLimitValuesFor(
  snapshot: ModelRateLimitSnapshot,
  identity: ModelRateLimitIdentity,
): ModelRateLimitValues | undefined {
  return snapshot.limits.get(identity.provider)?.get(identity.modelId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitConfig.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/rateLimits/modelRateLimitConfig.ts src/server/rateLimits/modelRateLimitConfig.test.ts
git commit -m "feat(models): extract per-model rate limit snapshots"
```

## Task 4: Rolling-window rate-limit owner

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/rateLimits/modelRateLimitOwner.ts`
- Create: `src/server/rateLimits/modelRateLimitTestSupport.ts`
- Test: `src/server/rateLimits/modelRateLimitOwner.test.ts`

**Interfaces:**

- Consumes: `MODEL_RATE_LIMIT_WINDOW_MS`, `sumModelTerminalTokens(usage)`, `type ModelRateLimitValues` from Task 1; `modelRateLimitValuesFor(snapshot, identity)`, `type ModelRateLimitIdentity`, `type ModelRateLimitSnapshot` from Task 3.
- Produces: `interface ModelRateLimitTimerHandle { cancel(): void }`;
  `interface ModelRateLimitClock { now(): number; schedule(delayMs: number, callback: () => void): ModelRateLimitTimerHandle }`;
  `const modelRateLimitDefaultClock: ModelRateLimitClock`;
  `interface ModelRateLimitOwnerLogger { warn(details: Record<string, unknown>, message: string): void }`;
  `const MODEL_RATE_LIMITS_BLOCKED_CODE = "MODEL_RATE_LIMITS_BLOCKED"`;
  `const MODEL_RATE_LIMITS_BLOCKED_MESSAGE = "Model requests are blocked because the model configuration is invalid."`;
  `interface ModelTerminalUsage { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }`;
  `type ModelAdmission = { readonly status: "granted" } | { readonly status: "aborted" } | { readonly status: "blocked"; readonly code: typeof MODEL_RATE_LIMITS_BLOCKED_CODE; readonly error: string }`;
  `interface ModelRateLimitOwnerStatus { revision: number; admission: "ready" | "blocked"; source: "none" | "missing-file" | "accepted-document" | "last-known-good"; error?: string }`;
  `interface ModelRateLimitOwner` with `acquire(identity, signal?): Promise<ModelAdmission>`, `completeCall(identity, usage): void`, `applySnapshot(snapshot, source: "missing-file" | "accepted-document"): number`, `reportLoadFailure(error: string): void`, `readStatus(): ModelRateLimitOwnerStatus`, `dispose(): void`, `pendingWaiterCount(identity?): number`, `activeTimerCount(): number`;
  `interface ModelRateLimitDiagnostics { activeIdentityCount(): number; inFlightCount(identity?: ModelRateLimitIdentity): number }` (diagnostics and tests only);
  `createModelRateLimitOwner(options?: { clock?: ModelRateLimitClock; logger?: ModelRateLimitOwnerLogger }): ModelRateLimitOwner & ModelRateLimitDiagnostics`;
  test support exports `createFakeModelRateLimitClock(start?: number): FakeModelRateLimitClock` where `FakeModelRateLimitClock` adds `advance(ms: number): void` and `pendingTimerCount(): number`; `fixtureTerminalMessage(overrides?: Partial<AssistantMessage>): AssistantMessage`; `createControllableStream(): { stream: AssistantMessageEventStream; push(event: AssistantMessageEvent): void; end(message: AssistantMessage): void; error(message: AssistantMessage): void }`; `deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }`; `fixtureLimits(tpm?: number, prm?: number): ModelRateLimitValues`; `fixtureIdentity(provider: string, modelId: string): ModelRateLimitIdentity`; `fixtureSnapshot(entries: Record<string, Record<string, ModelRateLimitValues>>): ModelRateLimitSnapshot`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { MODEL_RATE_LIMITS_BLOCKED_CODE, createModelRateLimitOwner } from "./modelRateLimitOwner";
import {
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
} from "./modelRateLimitTestSupport";

const demo = fixtureIdentity("acme", "demo-model");
const sibling = fixtureIdentity("acme", "sibling-model");

type LimitMap = Record<string, Record<string, { tpm?: number; prm?: number }>>;

function createOwner(limits: LimitMap = {}) {
  const clock = createFakeModelRateLimitClock();
  const rateLimits = createModelRateLimitOwner({ clock });
  rateLimits.applySnapshot(fixtureSnapshot(limits), "accepted-document");
  return { clock, rateLimits };
}

describe("model rate limit owner", () => {
  it("admits immediately when both dimensions are disabled", async () => {
    const { clock, rateLimits } = createOwner();

    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });

    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("admits exactly prm requests and queues the next request until the window expires", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 2) } });

    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(59_999);
    await Promise.resolve();
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(1);
    await expect(queued).resolves.toEqual({ status: "granted" });
  });

  it("uses strict inequality for tpm and ignores totalTokens", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 9, totalTokens: 100_000 });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
    rateLimits.completeCall(demo, { input: 1 });
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("sums all four terminal counters", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("expires request and token entries independently", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10, 1) } });

    await rateLimits.acquire(demo);
    clock.advance(30_000);
    rateLimits.completeCall(demo, { input: 10 });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(30_000);
    await Promise.resolve();
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    clock.advance(30_000);
    await expect(queued).resolves.toEqual({ status: "granted" });
  });

  it("allows an admitted call and concurrent in-flight calls to overshoot tpm", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 500 });
    const afterOvershoot = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(afterOvershoot).resolves.toEqual({ status: "aborted" });

    const concurrent = createOwner({ acme: { "demo-model": fixtureLimits(1) } });
    await concurrent.rateLimits.acquire(demo);
    await concurrent.rateLimits.acquire(demo);
    concurrent.rateLimits.completeCall(demo, { input: 50 });
    concurrent.rateLimits.completeCall(demo, { input: 50 });
    const third = concurrent.rateLimits.acquire(demo);
    expect(concurrent.rateLimits.pendingWaiterCount(demo)).toBe(1);
    concurrent.rateLimits.dispose();
    await expect(third).resolves.toEqual({ status: "aborted" });
  });

  it("keeps disabled dimensions independent", async () => {
    const tpmOnly = createOwner({ acme: { "demo-model": fixtureLimits(5) } });
    await tpmOnly.rateLimits.acquire(demo);
    tpmOnly.rateLimits.completeCall(demo, { output: 5 });
    const blocked = tpmOnly.rateLimits.acquire(demo);
    expect(tpmOnly.rateLimits.pendingWaiterCount(demo)).toBe(1);
    tpmOnly.rateLimits.dispose();
    await expect(blocked).resolves.toEqual({ status: "aborted" });

    const prmOnly = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 5) } });
    for (let index = 0; index < 5; index += 1) await prmOnly.rateLimits.acquire(demo);
    prmOnly.rateLimits.completeCall(demo, { input: 1_000_000 });
    const sixth = prmOnly.rateLimits.acquire(demo);
    expect(prmOnly.rateLimits.pendingWaiterCount(demo)).toBe(1);
    prmOnly.rateLimits.dispose();
    await expect(sixth).resolves.toEqual({ status: "aborted" });
  });

  it("grants queued waiters in FIFO order", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1, 10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    const order: string[] = [];
    const second = rateLimits.acquire(demo).then(() => { order.push("second"); });
    const third = rateLimits.acquire(demo).then(() => { order.push("third"); });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(2);

    clock.advance(60_000);
    await Promise.all([second, third]);

    expect(order).toEqual(["second", "third"]);
  });

  it("does not starve the next waiter when the head is cancelled", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const controller = new AbortController();
    const cancelled = rateLimits.acquire(demo, controller.signal);
    const next = rateLimits.acquire(demo);
    controller.abort();

    await expect(cancelled).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    clock.advance(60_000);
    await expect(next).resolves.toEqual({ status: "granted" });
  });

  it("leaves other models unblocked", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1), "sibling-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    await expect(rateLimits.acquire(sibling)).resolves.toEqual({ status: "granted" });
  });

  it("wakes eligible waiters when a limit is raised or disabled and keeps them waiting when lowered", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(100) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 100 });
    const raised = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(150) } }), "accepted-document");
    await expect(raised).resolves.toEqual({ status: "granted" });

    rateLimits.completeCall(demo, { input: 50 });
    const disabled = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.applySnapshot(fixtureSnapshot({}), "accepted-document");
    await expect(disabled).resolves.toEqual({ status: "granted" });

    const lowered = createOwner({ acme: { "demo-model": fixtureLimits(100) } });
    await lowered.rateLimits.acquire(demo);
    lowered.rateLimits.completeCall(demo, { input: 100 });
    const queued = lowered.rateLimits.acquire(demo);
    lowered.rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(10) } }), "accepted-document");
    expect(lowered.rateLimits.pendingWaiterCount(demo)).toBe(1);
    lowered.rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("retains recent usage across snapshot publication", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(10) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 10 });
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(10, 4) } }), "accepted-document");
    const queued = rateLimits.acquire(demo);

    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);
    rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("removes the restriction without cancelling work when an identity leaves the snapshot", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1), "sibling-model": fixtureLimits(1) } });

    await rateLimits.acquire(demo);
    rateLimits.completeCall(demo, { input: 1 });
    const queued = rateLimits.acquire(demo);
    expect(rateLimits.pendingWaiterCount(demo)).toBe(1);

    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "sibling-model": fixtureLimits(1) } }), "accepted-document");
    await expect(queued).resolves.toEqual({ status: "granted" });
    expect(rateLimits.pendingWaiterCount(sibling)).toBe(0);
  });

  it("keeps at most one timer per blocked identity and clears it after draining", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const first = rateLimits.acquire(demo);
    const second = rateLimits.acquire(demo);
    expect(rateLimits.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);

    clock.advance(60_000);
    await expect(first).resolves.toEqual({ status: "granted" });
    expect(rateLimits.activeTimerCount()).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);

    rateLimits.dispose();
    await expect(second).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it("releases in-flight counts on completion and prunes idle states", async () => {
    const { rateLimits } = createOwner();

    await rateLimits.acquire(demo);
    expect(rateLimits.inFlightCount(demo)).toBe(1);
    expect(rateLimits.activeIdentityCount()).toBe(1);

    rateLimits.completeCall(demo, undefined);
    expect(rateLimits.inFlightCount(demo)).toBe(0);
    expect(rateLimits.activeIdentityCount()).toBe(0);
  });

  it("keeps states with waiters, history, or configured limits", async () => {
    const withLimits = createOwner({ acme: { "demo-model": fixtureLimits(10) } });
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);

    await withLimits.rateLimits.acquire(demo);
    withLimits.rateLimits.completeCall(demo, { input: 10 });
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);

    const queued = withLimits.rateLimits.acquire(demo);
    expect(withLimits.rateLimits.pendingWaiterCount(demo)).toBe(1);
    expect(withLimits.rateLimits.activeIdentityCount()).toBe(1);
    withLimits.rateLimits.dispose();
    await expect(queued).resolves.toEqual({ status: "aborted" });
  });

  it("returns a structured blocked admission without queueing when no snapshot was accepted", async () => {
    const clock = createFakeModelRateLimitClock();
    const rateLimits = createModelRateLimitOwner({ clock });
    rateLimits.reportLoadFailure("models.json could not be parsed: bad");

    expect(rateLimits.readStatus()).toEqual({ revision: 0, admission: "blocked", source: "none", error: "models.json could not be parsed: bad" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({
      status: "blocked",
      code: MODEL_RATE_LIMITS_BLOCKED_CODE,
      error: "models.json could not be parsed: bad",
    });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
  });

  it("keeps last-known-good limits after a later load failure", async () => {
    const { rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(1) } });

    rateLimits.reportLoadFailure("models.json could not be parsed: bad");

    expect(rateLimits.readStatus()).toEqual({ revision: 1, admission: "ready", source: "last-known-good", error: "models.json could not be parsed: bad" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "granted" });
  });

  it("rejects an already-aborted acquire without creating state", async () => {
    const { rateLimits } = createOwner();
    const controller = new AbortController();
    controller.abort();

    await expect(rateLimits.acquire(demo, controller.signal)).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.activeIdentityCount()).toBe(0);
  });

  it("settles waiters and clears timers on dispose and stops accepting work", async () => {
    const { clock, rateLimits } = createOwner({ acme: { "demo-model": fixtureLimits(undefined, 1) } });

    await rateLimits.acquire(demo);
    const queued = rateLimits.acquire(demo);
    expect(clock.pendingTimerCount()).toBe(1);

    rateLimits.dispose();

    await expect(queued).resolves.toEqual({ status: "aborted" });
    await expect(rateLimits.acquire(demo)).resolves.toEqual({ status: "aborted" });
    expect(rateLimits.pendingWaiterCount(demo)).toBe(0);
    expect(rateLimits.activeTimerCount()).toBe(0);
    expect(rateLimits.activeIdentityCount()).toBe(0);
    expect(clock.pendingTimerCount()).toBe(0);
    rateLimits.completeCall(demo, { input: 1 });
    expect(rateLimits.inFlightCount(demo)).toBe(0);
  });

  it("logs one queue warning per transition and one warning per blocked admission", async () => {
    const warn = vi.fn();
    const clock = createFakeModelRateLimitClock();
    const rateLimits = createModelRateLimitOwner({ clock, logger: { warn } });
    rateLimits.applySnapshot(fixtureSnapshot({ acme: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");

    await rateLimits.acquire(demo);
    const first = rateLimits.acquire(demo);
    const second = rateLimits.acquire(demo);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ provider: "acme", modelId: "demo-model", dimension: "prm" });

    rateLimits.dispose();
    await expect(first).resolves.toEqual({ status: "aborted" });
    await expect(second).resolves.toEqual({ status: "aborted" });

    const blockedWarn = vi.fn();
    const blocked = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock(), logger: { warn: blockedWarn } });
    blocked.reportLoadFailure("bad file");
    await blocked.acquire(demo);
    expect(blockedWarn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitOwner.test.ts`
Expected: FAIL, `Cannot find module './modelRateLimitOwner'`.

- [ ] **Step 3: Write the minimal implementation**

`src/server/rateLimits/modelRateLimitOwner.ts`:

```ts
import {
  MODEL_RATE_LIMIT_WINDOW_MS,
  sumModelTerminalTokens,
  type ModelRateLimitValues,
} from "../../shared/modelRateLimits.js";
import {
  modelRateLimitValuesFor,
  type ModelRateLimitIdentity,
  type ModelRateLimitSnapshot,
} from "./modelRateLimitConfig.js";

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
  applySnapshot(snapshot: ModelRateLimitSnapshot, source: "missing-file" | "accepted-document"): number;
  reportLoadFailure(error: string): void;
  readStatus(): ModelRateLimitOwnerStatus;
  dispose(): void;
  /** Diagnostics and tests only. */
  pendingWaiterCount(identity?: ModelRateLimitIdentity): number;
  activeTimerCount(): number;
}

/** Diagnostics and tests only; not part of the limiter policy contract. */
export interface ModelRateLimitDiagnostics {
  activeIdentityCount(): number;
  inFlightCount(identity?: ModelRateLimitIdentity): number;
}

export interface ModelRateLimitOwnerOptions {
  clock?: ModelRateLimitClock;
  logger?: ModelRateLimitOwnerLogger;
}

interface ModelCallWaiter {
  resolve(result: ModelAdmission): void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

interface ModelCallBudgetState {
  limits: ModelRateLimitValues;
  requestTimestamps: number[];
  tokenUsages: { at: number; tokens: number }[];
  queue: ModelCallWaiter[];
  timer: ModelRateLimitTimerHandle | undefined;
  inFlight: number;
  queuedLogged: boolean;
}

export function createModelRateLimitOwner(
  options: ModelRateLimitOwnerOptions = {},
): ModelRateLimitOwner & ModelRateLimitDiagnostics {
  return new ModelRateLimitOwnerImpl(options.clock ?? modelRateLimitDefaultClock, options.logger);
}

class ModelRateLimitOwnerImpl implements ModelRateLimitOwner, ModelRateLimitDiagnostics {
  private readonly states = new Map<string, Map<string, ModelCallBudgetState>>();
  private revision = 0;
  private admission: "ready" | "blocked" = "ready";
  private source: ModelRateLimitOwnerStatus["source"] = "none";
  private error: string | undefined;
  private disposed = false;

  constructor(
    private readonly clock: ModelRateLimitClock,
    private readonly logger: ModelRateLimitOwnerLogger | undefined,
  ) {}

  async acquire(identity: ModelRateLimitIdentity, signal?: AbortSignal): Promise<ModelAdmission> {
    if (this.disposed || signal?.aborted === true) return { status: "aborted" };
    if (this.admission === "blocked") {
      const error = this.error ?? MODEL_RATE_LIMITS_BLOCKED_MESSAGE;
      this.logger?.warn(
        { provider: identity.provider, modelId: identity.modelId, error },
        "model request blocked by invalid models configuration",
      );
      return { status: "blocked", code: MODEL_RATE_LIMITS_BLOCKED_CODE, error };
    }

    const state = this.stateFor(identity);
    const now = this.clock.now();
    this.prune(state, now);
    if (state.queue.length === 0 && this.canAdmit(state)) {
      state.requestTimestamps.push(now);
      state.inFlight += 1;
      return { status: "granted" };
    }

    let settle: ((result: ModelAdmission) => void) | undefined;
    const waiter: ModelCallWaiter = {
      resolve: (result) => { settle?.(result); },
      signal,
      onAbort: undefined,
      settled: false,
    };
    const result = new Promise<ModelAdmission>((resolve) => { settle = resolve; });
    state.queue.push(waiter);
    if (signal !== undefined) {
      waiter.onAbort = () => { this.abortWaiter(state, waiter); };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    if (!state.queuedLogged) {
      state.queuedLogged = true;
      this.logger?.warn(
        { provider: identity.provider, modelId: identity.modelId, dimension: this.exhaustedDimension(state) },
        "model request queued for rate limit",
      );
    }
    this.drain(state);
    this.schedule(state);
    return await result;
  }

  completeCall(identity: ModelRateLimitIdentity, usage: ModelTerminalUsage | undefined): void {
    if (this.disposed) return;
    const state = this.find(identity);
    if (state === undefined) return;
    if (state.inFlight > 0) state.inFlight -= 1;
    const tokens = sumModelTerminalTokens(usage);
    const now = this.clock.now();
    if (tokens > 0) state.tokenUsages.push({ at: now, tokens });
    this.prune(state, now);
    if (state.queue.length > 0) {
      this.drain(state);
      this.schedule(state);
    }
    this.pruneIdleState(identity, state);
  }

  applySnapshot(snapshot: ModelRateLimitSnapshot, source: "missing-file" | "accepted-document"): number {
    if (this.disposed) return this.revision;
    for (const [provider, models] of snapshot.limits) {
      for (const [modelId, limits] of models) {
        this.stateFor({ provider, modelId }).limits = { ...limits };
      }
    }
    for (const [provider, providerStates] of this.states) {
      for (const [modelId, state] of providerStates) {
        if (modelRateLimitValuesFor(snapshot, { provider, modelId }) === undefined) state.limits = {};
      }
    }
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        if (state.queue.length === 0) continue;
        this.drain(state);
        this.schedule(state);
      }
    }
    this.revision += 1;
    this.admission = "ready";
    this.source = source;
    this.error = undefined;
    this.pruneIdleStates();
    return this.revision;
  }

  reportLoadFailure(error: string): void {
    this.error = error;
    if (this.revision > 0) {
      this.source = "last-known-good";
      return;
    }
    this.admission = "blocked";
  }

  readStatus(): ModelRateLimitOwnerStatus {
    return {
      revision: this.revision,
      admission: this.admission,
      source: this.source,
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        this.cancelTimer(state);
        for (const waiter of state.queue) {
          this.removeAbortListener(waiter);
          this.settleWaiter(waiter, { status: "aborted" });
        }
        state.queue.length = 0;
        state.requestTimestamps.length = 0;
        state.tokenUsages.length = 0;
        state.inFlight = 0;
      }
    }
    this.states.clear();
  }

  pendingWaiterCount(identity?: ModelRateLimitIdentity): number {
    if (identity !== undefined) return this.find(identity)?.queue.length ?? 0;
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) count += state.queue.length;
    }
    return count;
  }

  activeTimerCount(): number {
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) {
        if (state.timer !== undefined) count += 1;
      }
    }
    return count;
  }

  activeIdentityCount(): number {
    let count = 0;
    for (const providerStates of this.states.values()) count += providerStates.size;
    return count;
  }

  inFlightCount(identity?: ModelRateLimitIdentity): number {
    if (identity !== undefined) return this.find(identity)?.inFlight ?? 0;
    let count = 0;
    for (const providerStates of this.states.values()) {
      for (const state of providerStates.values()) count += state.inFlight;
    }
    return count;
  }

  private stateFor(identity: ModelRateLimitIdentity): ModelCallBudgetState {
    let providerStates = this.states.get(identity.provider);
    if (providerStates === undefined) {
      providerStates = new Map();
      this.states.set(identity.provider, providerStates);
    }
    let state = providerStates.get(identity.modelId);
    if (state === undefined) {
      state = {
        limits: {},
        requestTimestamps: [],
        tokenUsages: [],
        queue: [],
        timer: undefined,
        inFlight: 0,
        queuedLogged: false,
      };
      providerStates.set(identity.modelId, state);
    }
    return state;
  }

  private find(identity: ModelRateLimitIdentity): ModelCallBudgetState | undefined {
    return this.states.get(identity.provider)?.get(identity.modelId);
  }

  private prune(state: ModelCallBudgetState, now: number): void {
    const cutoff = now - MODEL_RATE_LIMIT_WINDOW_MS;
    while (state.requestTimestamps.length > 0 && (state.requestTimestamps[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
      state.requestTimestamps.shift();
    }
    while (state.tokenUsages.length > 0 && (state.tokenUsages[0]?.at ?? Number.POSITIVE_INFINITY) <= cutoff) {
      state.tokenUsages.shift();
    }
  }

  private retainedTokenSum(state: ModelCallBudgetState): number {
    let sum = 0;
    for (const usage of state.tokenUsages) sum += usage.tokens;
    return sum;
  }

  private canAdmit(state: ModelCallBudgetState): boolean {
    if (state.limits.prm !== undefined && state.requestTimestamps.length >= state.limits.prm) return false;
    return state.limits.tpm === undefined || this.retainedTokenSum(state) < state.limits.tpm;
  }

  private exhaustedDimension(state: ModelCallBudgetState): "tpm" | "prm" | "tpm+prm" | undefined {
    const prmExhausted = state.limits.prm !== undefined && state.requestTimestamps.length >= state.limits.prm;
    const tpmExhausted = state.limits.tpm !== undefined && this.retainedTokenSum(state) >= state.limits.tpm;
    if (prmExhausted && tpmExhausted) return "tpm+prm";
    if (prmExhausted) return "prm";
    if (tpmExhausted) return "tpm";
    return undefined;
  }

  private drain(state: ModelCallBudgetState): void {
    const now = this.clock.now();
    this.prune(state, now);
    while (state.queue.length > 0) {
      const head = state.queue[0];
      if (head === undefined) break;
      if (head.signal?.aborted === true) {
        state.queue.shift();
        this.removeAbortListener(head);
        this.settleWaiter(head, { status: "aborted" });
        continue;
      }
      if (!this.canAdmit(state)) break;
      state.queue.shift();
      this.removeAbortListener(head);
      state.requestTimestamps.push(now);
      state.inFlight += 1;
      this.settleWaiter(head, { status: "granted" });
    }
    if (state.queue.length === 0) {
      this.cancelTimer(state);
      state.queuedLogged = false;
    } else {
      this.schedule(state);
    }
  }

  private schedule(state: ModelCallBudgetState): void {
    if (state.queue.length === 0 || (state.requestTimestamps.length === 0 && state.tokenUsages.length === 0)) {
      this.cancelTimer(state);
      return;
    }
    const now = this.clock.now();
    const requestHead = state.requestTimestamps[0];
    const tokenHead = state.tokenUsages[0];
    const earliest = Math.min(requestHead ?? Number.POSITIVE_INFINITY, tokenHead?.at ?? Number.POSITIVE_INFINITY);
    if (!Number.isFinite(earliest)) {
      this.cancelTimer(state);
      return;
    }
    const delay = Math.max(0, earliest + MODEL_RATE_LIMIT_WINDOW_MS - now);
    this.cancelTimer(state);
    state.timer = this.clock.schedule(delay, () => {
      state.timer = undefined;
      this.prune(state, this.clock.now());
      this.drain(state);
      this.schedule(state);
    });
  }

  private abortWaiter(state: ModelCallBudgetState, waiter: ModelCallWaiter): void {
    if (waiter.settled) return;
    const index = state.queue.indexOf(waiter);
    if (index === -1) return;
    const wasHead = index === 0;
    state.queue.splice(index, 1);
    this.removeAbortListener(waiter);
    this.settleWaiter(waiter, { status: "aborted" });
    if (wasHead) this.drain(state);
    this.schedule(state);
    if (state.queue.length === 0) state.queuedLogged = false;
  }

  private settleWaiter(waiter: ModelCallWaiter, result: ModelAdmission): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.resolve(result);
  }

  private removeAbortListener(waiter: ModelCallWaiter): void {
    if (waiter.signal === undefined || waiter.onAbort === undefined) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = undefined;
  }

  private cancelTimer(state: ModelCallBudgetState): void {
    state.timer?.cancel();
    state.timer = undefined;
  }

  private pruneIdleState(identity: ModelRateLimitIdentity, state: ModelCallBudgetState): void {
    if (
      state.queue.length > 0 ||
      state.inFlight > 0 ||
      state.requestTimestamps.length > 0 ||
      state.tokenUsages.length > 0 ||
      hasEnabledLimit(state.limits)
    ) return;
    const providerStates = this.states.get(identity.provider);
    providerStates?.delete(identity.modelId);
    if (providerStates?.size === 0) this.states.delete(identity.provider);
  }

  private pruneIdleStates(): void {
    for (const [provider, providerStates] of [...this.states]) {
      for (const [modelId, state] of [...providerStates]) {
        this.pruneIdleState({ provider, modelId }, state);
      }
    }
  }
}

function hasEnabledLimit(limits: ModelRateLimitValues): boolean {
  return limits.tpm !== undefined || limits.prm !== undefined;
}
```

`src/server/rateLimits/modelRateLimitTestSupport.ts`:

```ts
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ModelRateLimitValues } from "../../shared/modelRateLimits.js";
import type { ModelRateLimitIdentity, ModelRateLimitSnapshot } from "./modelRateLimitConfig.js";
import type { ModelRateLimitClock, ModelRateLimitTimerHandle } from "./modelRateLimitOwner.js";

export interface FakeModelRateLimitClock extends ModelRateLimitClock {
  advance(ms: number): void;
  pendingTimerCount(): number;
}

/** Deterministic monotonic clock; never touches real timers. */
export function createFakeModelRateLimitClock(start = 0): FakeModelRateLimitClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const earliest = (): { id: number; at: number; callback: () => void } | undefined => {
    let found: { id: number; at: number; callback: () => void } | undefined;
    for (const [id, timer] of timers) {
      if (found === undefined || timer.at < found.at || (timer.at === found.at && id < found.id)) {
        found = { id, at: timer.at, callback: timer.callback };
      }
    }
    return found;
  };

  return {
    now: () => current,
    schedule: (delayMs: number, callback: () => void): ModelRateLimitTimerHandle => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: current + Math.max(0, delayMs), callback });
      return { cancel: () => { timers.delete(id); } };
    },
    advance: (ms: number): void => {
      const target = current + Math.max(0, ms);
      for (;;) {
        const next = earliest();
        if (next === undefined || next.at > target) break;
        timers.delete(next.id);
        current = next.at;
        next.callback();
      }
      current = target;
    },
    pendingTimerCount: () => timers.size,
  };
}

export function fixtureTerminalMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "demo-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export interface ControllableStream {
  stream: AssistantMessageEventStream;
  push(event: AssistantMessageEvent): void;
  end(message: AssistantMessage): void;
  error(message: AssistantMessage): void;
}

/** A delegate stream a test drives event by event. */
export function createControllableStream(): ControllableStream {
  const stream = createAssistantMessageEventStream();
  return {
    stream,
    push: (event) => { stream.push(event); },
    end: (message) => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    },
    error: (message) => {
      stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
      stream.end(message);
    },
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

export function fixtureLimits(tpm?: number, prm?: number): ModelRateLimitValues {
  return { ...(tpm === undefined ? {} : { tpm }), ...(prm === undefined ? {} : { prm }) };
}

export function fixtureIdentity(provider: string, modelId: string): ModelRateLimitIdentity {
  return { provider, modelId };
}

export function fixtureSnapshot(entries: Record<string, Record<string, ModelRateLimitValues>>): ModelRateLimitSnapshot {
  const limits = new Map<string, Map<string, ModelRateLimitValues>>();
  for (const [provider, models] of Object.entries(entries)) {
    const providerLimits = new Map<string, ModelRateLimitValues>();
    for (const [modelId, values] of Object.entries(models)) providerLimits.set(modelId, values);
    limits.set(provider, providerLimits);
  }
  return { limits };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitOwner.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/rateLimits/modelRateLimitOwner.ts src/server/rateLimits/modelRateLimitTestSupport.ts src/server/rateLimits/modelRateLimitOwner.test.ts
git commit -m "feat(models): add rolling-window rate limit owner"
```

## Task 5: Stream and completion adapters

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/rateLimits/modelRateLimitAdapters.ts`
- Test: `src/server/rateLimits/modelRateLimitAdapters.test.ts`

**Interfaces:**

- Consumes: `MODEL_RATE_LIMITS_BLOCKED_MESSAGE`, `type ModelRateLimitOwner` from Task 4 (`acquire(identity, signal?)`, `completeCall(identity, usage)`, diagnostics); `type ModelRateLimitIdentity` from Task 3; fixture helpers from Task 4's `modelRateLimitTestSupport.ts`; `StreamFn` from `@earendil-works/pi-agent-core`; `AssistantMessage`, `AssistantMessageEventStream`, `Model`, `Context`, `ModelsSimpleStreamOptions` from `@earendil-works/pi-ai`.
- Produces: `wrapModelStream(owner: ModelRateLimitOwner, delegate: StreamFn): StreamFn`;
  `type ModelCompletionFunction = (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => Promise<AssistantMessage>`;
  `wrapModelCompletion(owner: ModelRateLimitOwner, delegate: ModelCompletionFunction): ModelCompletionFunction`;
  module-private `MODEL_RATE_LIMIT_WRAPPED` symbol guard so the same delegate is never double-wrapped.

- [ ] **Step 1: Write the failing test**

```ts
import { isRetryableAssistantError, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { wrapModelCompletion, wrapModelStream } from "./modelRateLimitAdapters";
import {
  MODEL_RATE_LIMITS_BLOCKED_MESSAGE,
  createModelRateLimitOwner,
  type ModelRateLimitOwner,
} from "./modelRateLimitOwner";
import {
  createControllableStream,
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "./modelRateLimitTestSupport";

const identity = fixtureIdentity("anthropic", "demo-model");

function fixtureModel(): Model<Api> {
  return {
    id: "demo-model",
    name: "Demo Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

function createOwner(tpm?: number, prm?: number) {
  const clock = createFakeModelRateLimitClock();
  const owner = createModelRateLimitOwner({ clock });
  owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(tpm, prm) } }), "accepted-document");
  return { clock, owner };
}

function terminalWithInput(input: number): AssistantMessage {
  const base = fixtureTerminalMessage();
  return fixtureTerminalMessage({ usage: { ...base.usage, input, totalTokens: input } });
}

describe("model rate limit stream adapter", () => {
  it("forwards delegate events in order and records usage before the terminal event", async () => {
    const { owner } = createOwner(5);
    const delegate = createControllableStream();
    const streamFn = vi.fn<StreamFn>(() => delegate.stream);
    const wrapped = wrapModelStream(owner, streamFn);
    const message = terminalWithInput(5);
    const events: string[] = [];

    const consumed = (async () => {
      for await (const event of wrapped(fixtureModel(), context, {})) {
        events.push(event.type);
        if (event.type === "done") {
          const followUp = owner.acquire(identity);
          expect(owner.pendingWaiterCount(identity)).toBe(1);
          owner.dispose();
          await expect(followUp).resolves.toEqual({ status: "aborted" });
        }
      }
    })();

    delegate.push({ type: "start", partial: message });
    delegate.push({ type: "text_delta", contentIndex: 0, delta: "o", partial: message });
    delegate.end(message);
    await consumed;

    expect(events).toEqual(["start", "text_delta", "done"]);
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("serves a .result()-only consumer that never iterates the wrapper", async () => {
    const { owner } = createOwner(5);
    const delegate = createControllableStream();
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => delegate.stream));
    const message = terminalWithInput(5);

    const result = wrapped(fixtureModel(), context, {}).result();
    delegate.push({ type: "start", partial: message });
    delegate.end(message);

    await expect(result).resolves.toEqual(message);
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("accounts duplicate terminal events once", async () => {
    const { owner } = createOwner(5);
    const delegate = createControllableStream();
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => delegate.stream));
    const message = terminalWithInput(5);

    const result = wrapped(fixtureModel(), context, {}).result();
    delegate.push({ type: "done", reason: "stop", message });
    delegate.push({ type: "done", reason: "stop", message: terminalWithInput(500) });

    await expect(result).resolves.toEqual(message);
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("settles synthesized errors for a synchronous throw and a rejected delegate", async () => {
    const sync = createOwner();
    const throwing = wrapModelStream(sync.owner, () => { throw new Error("sync boom"); });
    await expect(throwing(fixtureModel(), context, {}).result()).resolves.toMatchObject({ stopReason: "error", errorMessage: "sync boom" });
    expect(sync.owner.inFlightCount(identity)).toBe(0);

    const asyncOwner = createOwner();
    const rejecting = wrapModelStream(asyncOwner.owner, () => Promise.reject(new Error("async boom")));
    await expect(rejecting(fixtureModel(), context, {}).result()).resolves.toMatchObject({ stopReason: "error", errorMessage: "async boom" });
    expect(asyncOwner.owner.inFlightCount(identity)).toBe(0);
  });

  it("settles an error when the delegate stream ends without a terminal event", async () => {
    const { owner } = createOwner();
    const delegate = createControllableStream();
    const wrapped = wrapModelStream(owner, vi.fn<StreamFn>(() => delegate.stream));

    const result = wrapped(fixtureModel(), context, {}).result();
    delegate.stream.end();

    await expect(result).resolves.toMatchObject({ stopReason: "error", errorMessage: "Model stream ended without a final result." });
    expect(owner.inFlightCount(identity)).toBe(0);
  });

  it("never calls the delegate for a pre-dispatch abort and spends no prm unit", async () => {
    const { owner } = createOwner(undefined, 1);
    const controller = new AbortController();
    const streamFn = vi.fn<StreamFn>(() => { throw new Error("delegate must not run"); });
    const wrapped = wrapModelStream(owner, streamFn);

    controller.abort();
    await expect(wrapped(fixtureModel(), context, { signal: controller.signal }).result())
      .resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(streamFn).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);

    await owner.acquire(identity);
    const waiting = new AbortController();
    const queued = wrapped(fixtureModel(), context, { signal: waiting.signal }).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    waiting.abort();
    await expect(queued).resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(streamFn).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);
  });

  it("produces a blocked terminal that Pi does not classify as retryable", async () => {
    const owner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    owner.reportLoadFailure("models.json could not be parsed: bad");
    const streamFn = vi.fn<StreamFn>(() => { throw new Error("delegate must not run"); });

    const message = await wrapModelStream(owner, streamFn)(fixtureModel(), context, {}).result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(`${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} models.json could not be parsed: bad`);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("forwards delegate options unchanged and guards against double wrapping", async () => {
    const { owner } = createOwner();
    const delegate = createControllableStream();
    const streamFn = vi.fn<StreamFn>(() => delegate.stream);
    const wrapped = wrapModelStream(owner, streamFn);
    const options = { maxTokens: 7, reasoning: "low" as const, signal: new AbortController().signal };
    const model = {
      id: "demo-model",
      name: "Demo Model",
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    };

    wrapped(model, context, options);
    delegate.end(fixtureTerminalMessage());

    expect(streamFn).toHaveBeenCalledWith(model, context, options);
    expect(wrapModelStream(owner, wrapped)).toBe(wrapped);
    expect(wrapModelStream(owner, wrapModelStream(owner, streamFn))).toBe(wrapModelStream(owner, streamFn));
  });
});

describe("model rate limit completion adapter", () => {
  it("resolves the delegate message after recording usage once", async () => {
    const { owner } = createOwner(5);
    const message = terminalWithInput(5);
    const delegate = vi.fn(() => Promise.resolve(message));
    const complete = wrapModelCompletion(owner, delegate);

    await expect(complete(fixtureModel(), context)).resolves.toEqual(message);
    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("resolves aborted and blocked terminals without calling the delegate", async () => {
    const abortedOwner = createOwner().owner;
    const controller = new AbortController();
    controller.abort();
    const delegate = vi.fn(() => Promise.resolve(terminalWithInput(0)));

    await expect(wrapModelCompletion(abortedOwner, delegate)(fixtureModel(), context, { signal: controller.signal }))
      .resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(delegate).not.toHaveBeenCalled();

    const blockedOwner: ModelRateLimitOwner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    blockedOwner.reportLoadFailure("bad file");
    await expect(wrapModelCompletion(blockedOwner, delegate)(fixtureModel(), context))
      .resolves.toMatchObject({ stopReason: "error", errorMessage: `${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} bad file` });
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects a delegate failure after one completion", async () => {
    const { owner } = createOwner();
    const failure = new Error("delegate failed");
    const delegate = vi.fn(() => Promise.reject(failure));

    await expect(wrapModelCompletion(owner, delegate)(fixtureModel(), context)).rejects.toBe(failure);
    expect(owner.inFlightCount(identity)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitAdapters.test.ts`
Expected: FAIL, `Cannot find module './modelRateLimitAdapters'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRateLimitIdentity } from "./modelRateLimitConfig.js";
import {
  MODEL_RATE_LIMITS_BLOCKED_MESSAGE,
  type ModelRateLimitOwner,
} from "./modelRateLimitOwner.js";

const MODEL_RATE_LIMIT_WRAPPED = Symbol("pi-webui.modelRateLimitWrapped");

/** Pi's direct completion surface, e.g. `ModelRuntime.completeSimple`. */
export type ModelCompletionFunction = (
  model: Model<Api>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Wraps Pi's stream function with admission and terminal accounting. */
export function wrapModelStream(owner: ModelRateLimitOwner, delegate: StreamFn): StreamFn {
  if (isWrapped(delegate)) return delegate;
  const wrapped: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const identity: ModelRateLimitIdentity = { provider: model.provider, modelId: model.id };
    void pumpModelStream(owner, delegate, stream, identity, model, context, options);
    return stream;
  };
  Object.defineProperty(wrapped, MODEL_RATE_LIMIT_WRAPPED, { value: true, enumerable: false });
  return wrapped;
}

/** Wraps a direct completion function with admission and terminal accounting. */
export function wrapModelCompletion(
  owner: ModelRateLimitOwner,
  delegate: ModelCompletionFunction,
): ModelCompletionFunction {
  return async (model, context, options) => {
    const identity: ModelRateLimitIdentity = { provider: model.provider, modelId: model.id };
    const admission = await owner.acquire(identity, options?.signal);
    if (admission.status === "blocked") {
      return synthesizedTerminal(model, "error", `${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} ${admission.error}`);
    }
    if (admission.status === "aborted") return synthesizedTerminal(model, "aborted", "Request was aborted");

    try {
      const message = await delegate(model, context, options);
      owner.completeCall(identity, message.usage);
      return message;
    } catch (error) {
      owner.completeCall(identity, undefined);
      throw error;
    }
  };
}

async function pumpModelStream(
  owner: ModelRateLimitOwner,
  delegate: StreamFn,
  stream: AssistantMessageEventStream,
  identity: ModelRateLimitIdentity,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  let settled = false;
  const settle = (message: AssistantMessage): void => {
    if (settled) return;
    settled = true;
    stream.end(message);
  };

  const admission = await owner.acquire(identity, options?.signal);
  if (admission.status === "blocked") {
    const message = synthesizedTerminal(model, "error", `${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} ${admission.error}`);
    stream.push({ type: "error", reason: "error", error: message });
    settle(message);
    return;
  }
  if (admission.status === "aborted") {
    const message = synthesizedTerminal(model, "aborted", "Request was aborted");
    stream.push({ type: "error", reason: "aborted", error: message });
    settle(message);
    return;
  }

  try {
    const returned = delegate(model, context, options);
    const delegateStream = returned instanceof Promise ? await returned : returned;
    for await (const event of delegateStream) {
      if (event.type === "done" || event.type === "error") {
        const terminal = event.type === "done" ? event.message : event.error;
        owner.completeCall(identity, terminal.usage);
        if (!settled) {
          settled = true;
          stream.push(event);
          stream.end(terminal);
        }
        return;
      }
      stream.push(event);
    }
    const message = synthesizedTerminal(model, "error", "Model stream ended without a final result.");
    if (!settled) {
      settled = true;
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
    owner.completeCall(identity, undefined);
  } catch (error) {
    const message = synthesizedTerminal(model, "error", error instanceof Error ? error.message : String(error));
    if (!settled) {
      settled = true;
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    }
    owner.completeCall(identity, undefined);
  }
}

function synthesizedTerminal(model: Model<Api>, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function isWrapped(delegate: StreamFn): boolean {
  return Reflect.get(delegate, MODEL_RATE_LIMIT_WRAPPED) === true;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitAdapters.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/rateLimits/modelRateLimitAdapters.ts src/server/rateLimits/modelRateLimitAdapters.test.ts
git commit -m "feat(models): wrap Pi stream and completion calls with the limiter"
```

## Task 6: Installed-Pi compatibility parity

**Implementer tier:** Standard

**Files:**

- Create: `src/server/rateLimits/modelRateLimitPiCompatibility.test.ts`

**Interfaces:**

- Consumes: `parseModelsJsonText`, `ModelsJsonParseError` from Task 2; `extractModelRateLimits`, `modelRateLimitValuesFor` from Task 3; `ModelRuntime` from `@earendil-works/pi-coding-agent`.
- Produces: test evidence only; no production change.
- Note: Pi 0.85.1 composes a fixed-shape runtime `Model` from `models.json`, so unknown-field preservation is asserted on PI WEBUI's parser/document side and non-reinterpretation on the runtime side. Do not assert unknown keys on the composed runtime object.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsConfigDocument } from "../../shared/apiTypes";
import { ModelsJsonParseError, parseModelsJsonText } from "../models/modelsJsonParser";
import { extractModelRateLimits, modelRateLimitValuesFor } from "./modelRateLimitConfig";

const tempDirs: string[] = [];

const PLAIN_FIXTURE = `{
  "customRootFlag": "kept",
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "customProviderFlag": "kept",
      "models": [
        { "id": "model-large", "name": "Large", "contextWindow": 200000, "maxTokens": 8192, "customModelFlag": "kept" },
        { "id": "model-small", "name": "Small" }
      ]
    }
  }
}`;

const LIMITED_FIXTURE = `{
  "customRootFlag": "kept",
  "providers": {
    "acme": {
      "name": "Acme",
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "customProviderFlag": "kept",
      "models": [
        { "id": "model-large", "name": "Large", "contextWindow": 200000, "maxTokens": 8192, "customModelFlag": "kept", "tpm": 100000, "prm": 60 },
        { "id": "model-small", "name": "Small", "tpm": 300000 }
      ]
    }
  }
}`;

const DIALECT_FIXTURE = `\uFEFF{ // acme provider\n "providers": { "acme": { "baseUrl": "https://api.example.test/v1", "api": "openai-completions", "apiKey": "test-key", "models": [{ "id": "demo", },], }, },\n}`;

const BLOCK_COMMENT_FIXTURE = `{
  "providers": {
    "acme": {
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      /* block comments are not Pi JSON */
      "models": [{ "id": "demo" }]
    }
  }
}`;

const DUPLICATE_FIXTURE = `{
  "providers": {
    "acme": {
      "baseUrl": "https://api.example.test/v1",
      "api": "openai-completions",
      "apiKey": "test-key",
      "models": [
        { "id": "demo", "maxTokens": 111, "tpm": 100 },
        { "id": "demo", "maxTokens": 4096, "tpm": 200 }
      ]
    }
  }
}`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("installed Pi 0.85.1 rate limit compatibility", () => {
  it("loads identical model behavior with and without tpm/prm", async () => {
    const plain = await createRuntime(PLAIN_FIXTURE);
    const limited = await createRuntime(LIMITED_FIXTURE);

    expect(plain.getError()).toBeUndefined();
    expect(limited.getError()).toBeUndefined();
    expect(modelSummary(limited)).toEqual(modelSummary(plain));
    expect(modelSummary(limited)).toEqual([
      {
        id: "model-large",
        api: "openai-completions",
        baseUrl: "https://api.example.test/v1",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: false,
        thinkingLevelMap: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: undefined,
      },
      {
        id: "model-small",
        api: "openai-completions",
        baseUrl: "https://api.example.test/v1",
        contextWindow: 128000,
        maxTokens: 16384,
        reasoning: false,
        thinkingLevelMap: undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: undefined,
      },
    ]);
  });

  it("preserves unknown fields in PI WEBUI's parser and does not reinterpret them", async () => {
    const document = parseModelsJsonText(LIMITED_FIXTURE) as ModelsConfigDocument;
    const provider = document.providers?.["acme"];

    expect(document["customRootFlag"]).toBe("kept");
    expect(provider?.["customProviderFlag"]).toBe("kept");
    expect(provider?.models?.[0]?.["customModelFlag"]).toBe("kept");

    const runtime = await createRuntime(LIMITED_FIXTURE);
    expect(runtime.getProvider("acme")?.baseUrl).toBe("https://api.example.test/v1");
    expect(runtime.getProvider("acme")?.name).toBe("Acme");
  });

  it("loads BOM, line comments, and trailing commas and rejects block comments in both parsers", async () => {
    const dialect = await createRuntime(DIALECT_FIXTURE);
    expect(dialect.getError()).toBeUndefined();
    expect(dialect.getModels("acme").map((model) => model.id)).toEqual(["demo"]);
    expect(parseModelsJsonText(DIALECT_FIXTURE)).toEqual({
      providers: { acme: { baseUrl: "https://api.example.test/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "demo" }] } },
    });

    const blockComment = await createRuntime(BLOCK_COMMENT_FIXTURE);
    expect(blockComment.getError()).toContain("Failed to parse models.json:");
    expect(() => parseModelsJsonText(BLOCK_COMMENT_FIXTURE)).toThrow(ModelsJsonParseError);
  });

  it("resolves duplicate model IDs with the last definition winning and agrees on limits", async () => {
    const runtime = await createRuntime(DUPLICATE_FIXTURE);
    const duplicates = runtime.getModels("acme").filter((model) => model.id === "demo");

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.maxTokens).toBe(4096);

    const extraction = extractModelRateLimits(parseModelsJsonText(DUPLICATE_FIXTURE) as ModelsConfigDocument);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;
    expect(modelRateLimitValuesFor(extraction.snapshot, { provider: "acme", modelId: "demo" })).toEqual({ tpm: 200 });
  });

  it("never rewrites or restats the source models.json", async () => {
    const directory = await fixtureDir(LIMITED_FIXTURE);
    const modelsPath = join(directory, "models.json");
    const before = await stat(modelsPath);
    const text = await readFile(modelsPath, "utf8");

    const runtime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });

    expect(runtime.getError()).toBeUndefined();
    expect(await readFile(modelsPath, "utf8")).toBe(text);
    expect((await stat(modelsPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps credentials configuration identical for both fixtures", async () => {
    const authPath = await authFilePath();
    const plain = await createRuntime(PLAIN_FIXTURE, authPath);
    const limited = await createRuntime(LIMITED_FIXTURE, authPath);

    expect(await limited.getAuth("anthropic")).toEqual(await plain.getAuth("anthropic"));
    expect(await limited.getAuth("acme")).toEqual(await plain.getAuth("acme"));
    expect(limited.getProviderAuthStatus("acme")).toEqual(plain.getProviderAuthStatus("acme"));
  });
});

function modelSummary(runtime: ModelRuntime) {
  return runtime.getModels("acme").map((model) => ({
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    compat: model.compat,
  }));
}

async function fixtureDir(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-rate-limit-pi-compat-"));
  tempDirs.push(directory);
  await writeFile(join(directory, "models.json"), text, "utf8");
  return directory;
}

async function createRuntime(modelsText: string, authPath?: string): Promise<ModelRuntime> {
  const directory = await fixtureDir(modelsText);
  return await ModelRuntime.create({
    modelsPath: join(directory, "models.json"),
    ...(authPath === undefined ? {} : { authPath }),
    allowModelNetwork: false,
  });
}

async function authFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-rate-limit-auth-"));
  tempDirs.push(directory);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-api-test" } }), "utf8");
  return authPath;
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitPiCompatibility.test.ts`
Expected: FAIL on the first run only if the fixture/helper is wrong; because Tasks 2 and 3 already exist this file compiles and passes immediately when written correctly. If it fails, read the actual Pi error text from `getError()` and adjust the expected summary values; keep the comparison `limited === plain` as the load-bearing assertion.

- [ ] **Step 3: Run the test and confirm it passes**

Run: `npm test -- --run src/server/rateLimits/modelRateLimitPiCompatibility.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 4: Commit**

```bash
git add src/server/rateLimits/modelRateLimitPiCompatibility.test.ts
git commit -m "test(models): prove installed Pi parity for rate limit fields"
```

## Task 7: Structured API contracts and limits sidecar plumbing

**Implementer tier:** Standard

**Files:**

- Modify: `src/shared/apiTypes.ts:1218-1257`
- Modify: `src/shared/federatedRoutes.ts:30-33`
- Modify: `src/server/sessiond/sessionProxyRoutes.ts:54-56`
- Test: `src/server/sessiond/sessionProxyRoutes.test.ts:286-296`
- Test: `src/server/app.remoteProxy.test.ts:549-567`

**Interfaces:**

- Consumes: `ModelRateLimitField`, `ModelRateLimitInvalidReason` from Task 1 (`import type { ModelRateLimitField, ModelRateLimitInvalidReason } from "./modelRateLimits.js";`).
- Produces: `ModelsConfigModel` with `tpm?: number | undefined; prm?: number | undefined`;
  `ModelsConfigSaveResponse = { success: true; contractVersion?: 1; revision?: number }`;
  `type ModelsConfigLimitsAdmission = "ready" | "blocked"`;
  `type ModelsConfigLimitsSource = "none" | "missing-file" | "accepted-document" | "last-known-good"`;
  `interface ModelsConfigLimitsStatusResponse { contractVersion: 1; revision: number; admission: ModelsConfigLimitsAdmission; source: ModelsConfigLimitsSource; error?: string }`;
  `type ModelsConfigErrorCode = "MODELS_CONFIG_PARSE_FAILED" | "MODELS_CONFIG_IO_FAILED" | "MODELS_CONFIG_SAVE_INVALID" | "MODELS_CONFIG_INVALID_LIMITS" | "MODELS_CONFIG_UNREADABLE" | "MODELS_CONFIG_PERSIST_FAILED" | "MODELS_CONFIG_REFRESH_FAILED" | "MODELS_CONFIG_INTERNAL"`;
  `interface ModelsConfigErrorResponse { error: string; code: ModelsConfigErrorCode; file: "models.json"; provider?: string; modelId?: string; field?: ModelRateLimitField; reason?: ModelRateLimitInvalidReason; occurrence?: number; persisted?: boolean }`;
  one `{ method: "GET", path: "/models-config/limits" }` entry in `FEDERATED_HTTP_ROUTES` (which also registers the remote machine proxy route);
  `${prefix}/models-config/limits` proxied by `registerSessionProxyRoutes`.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/sessiond/sessionProxyRoutes.test.ts` after the `"returns a 502 response when the daemon request fails"` test:

```ts
  it("proxies the models-config limits sidecar for the selected machine", async () => {
    const status = { contractVersion: 1, revision: 3, admission: "ready", source: "accepted-document" };
    daemon.respondWith({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(status) });

    const response = await app.inject({ method: "GET", url: "/api/machines/local/models-config/limits" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(daemon.requests).toEqual([{ method: "GET", path: "/models-config/limits", body: undefined }]);
  });
```

Add to `src/server/app.remoteProxy.test.ts` after the `"proxies remote session queue clearing through the allowlisted route"` test:

```ts
  it("allowlists and proxies the models-config limits sidecar exactly once", async () => {
    expect(FEDERATED_HTTP_ROUTES.filter((route) => route.path === "/models-config/limits")).toEqual([
      { method: "GET", path: "/models-config/limits" },
    ]);
    expect(REMOTE_HTTP_ROUTES).toContainEqual({ method: "GET", path: "/models-config/limits" });

    const status = { contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" };
    const request = vi.fn<MachineClient["request"]>(() => Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([JSON.stringify(status)]),
    }));
    const machineId = await addRemoteMachine(request);

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/machines/${machineId}/models-config/limits` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(status);
    expect(request).toHaveBeenCalledWith("GET", "/api/models-config/limits", undefined);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts`
Expected: FAIL: the limits path returns 404 in both suites.

- [ ] **Step 3: Modify `src/shared/apiTypes.ts`**

Add at the top of the file, next to any existing imports:

```ts
import type { ModelRateLimitField, ModelRateLimitInvalidReason } from "./modelRateLimits.js";
```

In `ModelsConfigModel`, after `compat?: Record<string, unknown> | undefined;`, add:

```ts
  /** Optional tokens-per-minute limit; omitted or 0 disables the dimension. */
  tpm?: number | undefined;
  /** Optional requests-per-minute limit; omitted or 0 disables the dimension. */
  prm?: number | undefined;
```

Replace `ModelsConfigSaveResponse` with:

```ts
export interface ModelsConfigSaveResponse {
  success: true;
  contractVersion?: 1;
  revision?: number;
}
```

Immediately after `ModelDiscoveryResponse`, insert:

```ts
/** Sidecar admission state reported by GET /models-config/limits. */
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

- [ ] **Step 4: Modify `src/shared/federatedRoutes.ts`**

Add to `FEDERATED_HTTP_ROUTES` directly after `{ method: "POST", path: "/models-config/discover" },`:

```ts
  { method: "GET", path: "/models-config/limits" },
```

- [ ] **Step 5: Modify `src/server/sessiond/sessionProxyRoutes.ts`**

Below the existing `app.all(`${prefix}/models-config/discover`, ...)` line, add:

```ts
  app.all(`${prefix}/models-config/limits`, (request, reply) => proxy(request, reply));
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npm test -- --run src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 7: Run the typecheck and commit**

Run: `npm run typecheck`
Expected: PASS (no errors; the added optional types are backward compatible).

```bash
git add src/shared/apiTypes.ts src/shared/federatedRoutes.ts src/server/sessiond/sessionProxyRoutes.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts
git commit -m "feat(models): add structured models-config contracts and limits sidecar route"
```

## Task 8: Models-config service lifecycle

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/models/modelsConfigService.ts:1-374`
- Modify: `src/server/models/modelsConfigService.test.ts:1-210`
- Modify: `src/server/sessiond.ts:11-12,82-83,173,203,219`
- Test: `src/server/models/modelsConfigService.rateLimits.test.ts`

**Interfaces:**

- Consumes: `parseModelsJsonText`, `ModelsJsonParseError` from Task 2; `emptyModelRateLimitSnapshot`, `extractModelRateLimits`, `type ModelRateLimitValidationError` from Task 3; `createModelRateLimitOwner`, `type ModelRateLimitOwner` from Task 4; `wrapModelCompletion`, `type ModelCompletionFunction` from Task 5; `ModelRateLimitField`, `modelRateLimitFieldMessage` from Task 1; `ModelsConfigDocument`, `ModelsConfigErrorCode`, `ModelsConfigLimitsStatusResponse`, `ModelsConfigSaveResponse` from Task 7.
- Produces: `class ModelsConfigServiceError extends Error` with `readonly code: ModelsConfigErrorCode`, `readonly details: ModelsConfigServiceErrorDetails`, and `ModelsConfigServiceErrorDetails = { provider?: string; modelId?: string; field?: ModelRateLimitField; reason?: ModelRateLimitInvalidReason; occurrence?: number; persisted?: boolean }`;
  `interface ModelsConfigServiceLogger { warn(details: Record<string, unknown>, message: string): void }`;
  `class ModelsConfigService` with `initialize(): Promise<void>`, `read(): Promise<ModelsConfigDocument>`, `readLimitsStatus(): ModelsConfigLimitsStatusResponse`, `save(value: unknown): Promise<ModelsConfigSaveResponse>`, `test(value: unknown): Promise<ModelConnectionTestResponse>`, `discover(value: unknown): Promise<ModelDiscoveryResponse>`;
  `validateModelsConfigDraftShape(value: unknown): { ok: true; document: ModelsConfigDocument } | { ok: false; message: string }`;
  `emptyModelsConfigDocument(): ModelsConfigDocument`;
  constructor dependency `rateLimits?: ModelRateLimitOwner` and `logger?: ModelsConfigServiceLogger`.

- [ ] **Step 1: Write the failing test**

```ts
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import { createFakeModelRateLimitClock, fixtureIdentity, fixtureTerminalMessage } from "../rateLimits/modelRateLimitTestSupport";
import { ModelsConfigService, validateModelsConfigDraftShape } from "./modelsConfigService";

const tempDirs: string[] = [];
const identity = fixtureIdentity("acme", "demo-model");

const EMPTY_DOCUMENT = { providers: {} };
const LIMITED_DOCUMENT = { providers: { acme: { models: [{ id: "demo", tpm: 50 }] } } };

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ModelsConfigService rate limit lifecycle", () => {
  it("reads a missing models.json as an empty document and publishes missing-file at startup", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).resolves.toEqual(EMPTY_DOCUMENT);
    expect(rateLimits.readStatus()).toEqual({ revision: 1, admission: "ready", source: "missing-file" });
  });

  it("reports a parse failure without substituting an empty document", async () => {
    const agentDir = await temporaryAgentDir();
    await writeFile(join(agentDir, "models.json"), "{ not json", "utf8");
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).rejects.toMatchObject({ code: "MODELS_CONFIG_PARSE_FAILED" });
    expect(rateLimits.readStatus()).toMatchObject({ revision: 0, admission: "blocked", source: "none" });
  });

  it("keeps an invalid-limits document readable while rejecting its snapshot", async () => {
    const agentDir = await temporaryAgentDir();
    const document = { providers: { acme: { models: [{ id: "demo", tpm: "bad" }] } } };
    await writeDocument(agentDir, document);
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await models.initialize();

    await expect(models.read()).resolves.toEqual(document);
    expect(rateLimits.readStatus()).toMatchObject({ revision: 0, admission: "blocked" });
  });

  it("rejects save shape and limit failures with structured details and no write", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const models = new ModelsConfigService({ agentDir, rateLimits });

    await expect(models.save({ providers: { acme: { models: [{ id: 5 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_SAVE_INVALID",
    });
    await expect(models.save({ providers: { acme: { models: [{ id: "demo", prm: -1 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_INVALID_LIMITS",
      details: { provider: "acme", modelId: "demo", field: "prm", reason: "negative", occurrence: 0 },
    });
    await expect(readFile(join(agentDir, "models.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to save over an unreadable on-disk file", async () => {
    const agentDir = await temporaryAgentDir();
    await writeFile(join(agentDir, "models.json"), "{ broken", "utf8");
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(EMPTY_DOCUMENT)).rejects.toMatchObject({ code: "MODELS_CONFIG_UNREADABLE" });
    expect(await readFile(join(agentDir, "models.json"), "utf8")).toBe("{ broken");
  });

  it("writes through a sibling temporary file with rename and preserves a restricted mode", async () => {
    const agentDir = await temporaryAgentDir();
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(LIMITED_DOCUMENT)).resolves.toEqual({ success: true, contractVersion: 1 });

    expect((await stat(modelsPath)).mode & 0o7777).toBe(0o600);
    expect(await readFile(modelsPath, "utf8")).toBe(`${JSON.stringify(LIMITED_DOCUMENT, null, 2)}\n`);
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("updates a symlinked target instead of replacing the link", async () => {
    const agentDir = await temporaryAgentDir();
    const realDir = await temporaryAgentDir();
    const realPath = join(realDir, "real-models.json");
    await writeFile(realPath, "{}\n", "utf8");
    await symlink(realPath, join(agentDir, "models.json"));
    const models = new ModelsConfigService({ agentDir });

    await models.save(LIMITED_DOCUMENT);

    expect(await readFile(realPath, "utf8")).toContain("demo");
    expect((await lstat(join(agentDir, "models.json"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a hard-linked target before creating a temporary file", async () => {
    const agentDir = await temporaryAgentDir();
    const otherDir = await temporaryAgentDir();
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, "{}\n", "utf8");
    await link(modelsPath, join(otherDir, "models.json"));
    const models = new ModelsConfigService({ agentDir });

    await expect(models.save(LIMITED_DOCUMENT)).rejects.toMatchObject({ code: "MODELS_CONFIG_PERSIST_FAILED" });
    expect((await readdir(agentDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps active limits when persistence fails", async () => {
    const agentDir = await temporaryAgentDir();
    const otherDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, LIMITED_DOCUMENT);
    const models = new ModelsConfigService({ agentDir, rateLimits });
    await models.initialize();
    const before = rateLimits.readStatus();
    await link(join(agentDir, "models.json"), join(otherDir, "models.json"));

    await expect(models.save({ providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } })).rejects.toMatchObject({
      code: "MODELS_CONFIG_PERSIST_FAILED",
    });

    expect(rateLimits.readStatus()).toEqual(before);
  });

  it("reports a narrow refresh failure with persisted true and keeps last-known-good", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, EMPTY_DOCUMENT);
    const modelRuntime = {
      refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
      getError: () => "Failed to parse models.json: bad",
    };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();

    await expect(models.save(LIMITED_DOCUMENT)).rejects.toMatchObject({
      code: "MODELS_CONFIG_REFRESH_FAILED",
      details: { persisted: true },
    });

    expect(await readFile(join(agentDir, "models.json"), "utf8")).toContain('"tpm": 50');
    expect(rateLimits.readStatus()).toMatchObject({ admission: "ready", source: "last-known-good" });
    expect(rateLimits.readStatus().error).toContain("Failed to parse models.json:");
  });

  it("ignores transient availability and catalog errors during refresh validation", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    await writeDocument(agentDir, EMPTY_DOCUMENT);
    const modelRuntime = {
      refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map([["acme", new Error("catalog down")]]) }),
      getError: () => "Availability refresh: acme failed\nCredential check failed for acme",
    };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();

    await expect(models.save(LIMITED_DOCUMENT)).resolves.toEqual({ success: true, contractVersion: 1, revision: 2 });
    expect(rateLimits.readStatus()).toEqual({ revision: 2, admission: "ready", source: "accepted-document" });
  });

  it("publishes a higher revision and wakes waiters after a successful save", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    const modelRuntime = { refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }), getError: () => undefined };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });
    await models.initialize();
    await models.save({ providers: { acme: { models: [{ id: "demo", tpm: 1, prm: 1 }] } } });
    await rateLimits.acquire(identity);
    rateLimits.completeCall(identity, { input: 1 });
    const queued = rateLimits.acquire(identity);
    expect(rateLimits.pendingWaiterCount(identity)).toBe(1);

    await models.save({ providers: { acme: { models: [{ id: "demo", tpm: 100, prm: 5 }] } } });

    await expect(queued).resolves.toEqual({ status: "granted" });
    expect(rateLimits.readStatus().revision).toBe(3);
  });

  it("serializes saves so an older save cannot publish over a newer one", async () => {
    const agentDir = await temporaryAgentDir();
    const { rateLimits } = ownerWithClock();
    let releaseRefresh: (() => void) | undefined;
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 1) await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      return { aborted: false, errors: new Map() };
    });
    const modelRuntime = { refresh, getError: () => undefined };
    const models = new ModelsConfigService({ agentDir, modelRuntime, rateLimits });

    const first = models.save({ providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } });
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1); });
    const second = models.save({ providers: { acme: { models: [{ id: "demo", tpm: 20 }] } } });
    expect(refresh).toHaveBeenCalledTimes(1);
    releaseRefresh?.();

    await expect(first).resolves.toEqual({ success: true, contractVersion: 1, revision: 1 });
    await expect(second).resolves.toEqual({ success: true, contractVersion: 1, revision: 2 });
    expect(await readFile(join(agentDir, "models.json"), "utf8")).toContain('"tpm": 20');
    expect(rateLimits.readStatus()).toEqual({ revision: 2, admission: "ready", source: "accepted-document" });
  });

  it("charges a connection test against saved limits and never publishes draft values", async () => {
    const agentDir = await temporaryAgentDir();
    const { clock, rateLimits } = ownerWithClock();
    await writeDocument(agentDir, {
      providers: { acme: { api: "openai-completions", baseUrl: "https://api.example.test/v1", apiKey: "test-key", models: [{ id: "demo", prm: 1 }] } },
    });
    const connectionModel = {
      id: "demo",
      name: "Demo",
      api: "openai-completions" as const,
      provider: "acme",
      baseUrl: "https://api.example.test/v1",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    };
    const completeSimple = vi.fn(() => Promise.resolve(fixtureTerminalMessage({ api: "openai-completions", provider: "acme", model: "demo" })));
    const models = new ModelsConfigService({
      agentDir,
      rateLimits,
      createConnectionRuntime: () => Promise.resolve({
        getError: () => undefined,
        getModel: () => connectionModel,
        getAuth: () => Promise.resolve({ auth: { apiKey: "test-key" } }),
        completeSimple,
      }),
    });
    await models.initialize();
    await rateLimits.acquire(identity);

    const testPromise = models.test({
      providerName: "acme",
      provider: { api: "openai-completions", baseUrl: "https://api.example.test/v1", apiKey: "test-key" },
      model: { id: "demo", tpm: 999_999 },
    });
    await vi.waitFor(() => { expect(rateLimits.pendingWaiterCount(identity)).toBe(1); });
    expect(completeSimple).not.toHaveBeenCalled();

    clock.advance(60_000);
    await expect(testPromise).resolves.toMatchObject({ ok: true });
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(rateLimits.readStatus().revision).toBe(1);
    expect(await readFile(join(agentDir, "models.json"), "utf8")).not.toContain("999999");
  });

  it("never throws from initialize when models.json cannot be read", async () => {
    const agentDir = await temporaryAgentDir();
    await mkdir(join(agentDir, "models.json"));
    const { rateLimits } = ownerWithClock();
    const logger = { warn: vi.fn() };
    const models = new ModelsConfigService({ agentDir, rateLimits, logger });

    await expect(models.initialize()).resolves.toBeUndefined();

    expect(rateLimits.readStatus().admission).toBe("blocked");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("validates the shared draft shape without dropping unknown fields", () => {
    expect(validateModelsConfigDraftShape(null)).toEqual({ ok: false, message: "models.json must be a JSON object" });
    expect(validateModelsConfigDraftShape({ providers: [] })).toEqual({ ok: false, message: "models.json providers must be an object" });
    expect(validateModelsConfigDraftShape({ providers: { acme: { models: "no" } } })).toEqual({
      ok: false,
      message: 'models.json provider "acme" models must be an array',
    });
    expect(validateModelsConfigDraftShape({ providers: { acme: { models: [{ id: 5 }] } } })).toEqual({
      ok: false,
      message: 'models.json provider "acme" model entries must have a string id',
    });
    expect(validateModelsConfigDraftShape({ rootFlag: true })).toEqual({ ok: true, document: { rootFlag: true, providers: {} } });
    expect(validateModelsConfigDraftShape({ rootFlag: true, providers: { acme: { custom: 1, models: [{ id: "" }] } } })).toEqual({
      ok: true,
      document: { rootFlag: true, providers: { acme: { custom: 1, models: [{ id: "" }] } } },
    });
  });
});

function ownerWithClock() {
  const clock = createFakeModelRateLimitClock();
  const rateLimits = createModelRateLimitOwner({ clock });
  return { clock, rateLimits };
}

async function temporaryAgentDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-webui-models-config-rate-limits-"));
  tempDirs.push(directory);
  return directory;
}

async function writeDocument(agentDir: string, document: unknown): Promise<void> {
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/models/modelsConfigService.rateLimits.test.ts`
Expected: FAIL, `validateModelsConfigDraftShape` is not exported and the save/refresh contracts are absent.

- [ ] **Step 3: Rewrite `src/server/models/modelsConfigService.ts`**

Replace the whole file with the complete listing below. Nothing is elided: the discovery helpers and connection-test implementation shown here are the current code with the described change applied.

```ts
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelConnectionTestRequest,
  ModelConnectionTestResponse,
  ModelDiscoveryModel,
  ModelDiscoveryRequest,
  ModelDiscoveryResponse,
  ModelsConfigDocument,
  ModelsConfigErrorCode,
  ModelsConfigLimitsStatusResponse,
  ModelsConfigProvider,
  ModelsConfigSaveResponse,
} from "../../shared/apiTypes.js";
import {
  modelRateLimitFieldMessage,
  type ModelRateLimitField,
  type ModelRateLimitInvalidReason,
} from "../../shared/modelRateLimits.js";
import { wrapModelCompletion, type ModelCompletionFunction } from "../rateLimits/modelRateLimitAdapters.js";
import {
  emptyModelRateLimitSnapshot,
  extractModelRateLimits,
  type ModelRateLimitValidationError,
} from "../rateLimits/modelRateLimitConfig.js";
import type { ModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner.js";
import { ModelsJsonParseError, parseModelsJsonText } from "./modelsJsonParser.js";

const MODEL_CONNECTION_TEST_TIMEOUT_MS = 20_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const MODEL_CONFIGURATION_ERROR_PREFIXES = [
  "Failed to load models.json:",
  "Failed to parse models.json:",
  "Invalid models.json schema:",
] as const;

type ModelConnectionRuntime = Pick<ModelRuntime, "getError" | "getModel" | "getAuth" | "completeSimple">;
type ModelConnectionRuntimeFactory = (options: { modelsPath: string; authPath: string }) => Promise<ModelConnectionRuntime>;
type ModelsReloadRuntime = Pick<ModelRuntime, "refresh" | "getError">;

export interface ModelsConfigServiceLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface ModelsConfigServiceErrorDetails {
  provider?: string;
  modelId?: string;
  field?: ModelRateLimitField;
  reason?: ModelRateLimitInvalidReason;
  occurrence?: number;
  persisted?: boolean;
}

/** Structured models-config failure; routes map `code` to an HTTP status. */
export class ModelsConfigServiceError extends Error {
  constructor(
    readonly code: ModelsConfigErrorCode,
    message: string,
    readonly details: ModelsConfigServiceErrorDetails = {},
  ) {
    super(message);
    this.name = "ModelsConfigServiceError";
  }
}

export interface ModelsConfigServiceDependencies {
  agentDir: string;
  /** The daemon's shared runtime, refreshed from models.json after a successful save. */
  modelRuntime?: ModelsReloadRuntime;
  createConnectionRuntime?: ModelConnectionRuntimeFactory;
  /** Daemon-owned limiter that receives accepted snapshots. */
  rateLimits?: ModelRateLimitOwner;
  logger?: ModelsConfigServiceLogger;
}

type StoredDocumentRead =
  | { kind: "missing" }
  | { kind: "document"; document: ModelsConfigDocument };

/**
 * Owns the active profile's editable `models.json` document and isolated model
 * connection checks. It intentionally lives with sessiond so file ownership and
 * credentials stay aligned with the long-lived Pi runtime.
 */
export class ModelsConfigService {
  private readonly modelsPath: string;
  private readonly authPath: string;
  private readonly modelRuntime: ModelsReloadRuntime | undefined;
  private readonly createConnectionRuntime: ModelConnectionRuntimeFactory;
  private readonly rateLimits: ModelRateLimitOwner | undefined;
  private readonly logger: ModelsConfigServiceLogger | undefined;
  private operationChain: Promise<void> = Promise.resolve();

  constructor({
    agentDir,
    modelRuntime,
    createConnectionRuntime = createConnectionRuntimeForProfile,
    rateLimits,
    logger,
  }: ModelsConfigServiceDependencies) {
    this.modelsPath = join(agentDir, "models.json");
    this.authPath = join(agentDir, "auth.json");
    this.modelRuntime = modelRuntime;
    this.createConnectionRuntime = createConnectionRuntime;
    this.rateLimits = rateLimits;
    this.logger = logger;
  }

  /** Reads, validates, and publishes the startup snapshot. Never throws. */
  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      let source: "missing-file" | "accepted-document" = "accepted-document";
      try {
        const loaded = await this.readStoredDocument();
        if (loaded.kind === "missing") source = "missing-file";
        const document = loaded.kind === "missing" ? emptyModelsConfigDocument() : loaded.document;
        const extraction = extractModelRateLimits(document);
        if (!extraction.ok) throw invalidLimitsError(extraction.errors[0]);
        this.rateLimits?.applySnapshot(extraction.snapshot, source);
      } catch (error) {
        this.rateLimits?.reportLoadFailure(errorMessage(error));
        this.logger?.warn({ file: "models.json", err: error }, "failed to load models.json");
      }
    });
  }

  async read(): Promise<ModelsConfigDocument> {
    const loaded = await this.readStoredDocument();
    return loaded.kind === "missing" ? emptyModelsConfigDocument() : loaded.document;
  }

  readLimitsStatus(): ModelsConfigLimitsStatusResponse {
    const status = this.rateLimits?.readStatus();
    if (status === undefined) return { contractVersion: 1, revision: 0, admission: "ready", source: "none" };
    return {
      contractVersion: 1,
      revision: status.revision,
      admission: status.admission,
      source: status.source,
      ...(status.error === undefined ? {} : { error: status.error }),
    };
  }

  async save(value: unknown): Promise<ModelsConfigSaveResponse> {
    return await this.enqueue(async () => {
      const shape = validateModelsConfigDraftShape(value);
      if (!shape.ok) {
        throw new ModelsConfigServiceError(
          "MODELS_CONFIG_SAVE_INVALID",
          `models.json save request is not a valid configuration: ${shape.message}`,
        );
      }

      const extraction = extractModelRateLimits(shape.document);
      if (!extraction.ok) throw invalidLimitsError(extraction.errors[0]);

      try {
        await this.readStoredDocument();
      } catch (error) {
        if (error instanceof ModelsConfigServiceError && error.code === "MODELS_CONFIG_PARSE_FAILED") {
          throw new ModelsConfigServiceError(
            "MODELS_CONFIG_UNREADABLE",
            "models.json could not be read as a valid configuration; fix the file and reload before saving.",
          );
        }
        throw error;
      }

      await this.persist(shape.document);
      await this.refreshAfterSave(shape.document);
      const revision = this.rateLimits?.applySnapshot(extraction.snapshot, "accepted-document");
      return {
        success: true,
        contractVersion: 1,
        ...(revision === undefined ? {} : { revision }),
      };
    });
  }

  async test(value: unknown): Promise<ModelConnectionTestResponse> {
    const request = parseModelConnectionTestRequest(value);
    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-webui-model-test-"));
      const temporaryModelsPath = join(temporaryDirectory, "models.json");
      await writeFile(temporaryModelsPath, JSON.stringify(modelsDocumentForConnectionTest(request), null, 2), "utf8");

      const runtime = await this.createConnectionRuntime({ modelsPath: temporaryModelsPath, authPath: this.authPath });
      const loadError = runtime.getError();
      if (loadError !== undefined) return { ok: false, error: loadError };

      const model = runtime.getModel(request.providerName, request.model.id);
      if (model === undefined) return { ok: false, error: `Model not found: ${request.providerName}/${request.model.id}` };

      const resolved = await runtime.getAuth(model);
      if (resolved?.auth.apiKey === undefined || resolved.auth.apiKey === "") {
        return { ok: false, error: `No API key found for "${request.providerName}"` };
      }

      const delegate: ModelCompletionFunction = (model, context, options) =>
        runtime.completeSimple(model, context, options);
      const rateLimits = this.rateLimits;
      const completeSimple = rateLimits === undefined ? delegate : wrapModelCompletion(rateLimits, delegate);
      return await runModelConnectionTest(completeSimple, model, resolved.auth.apiKey, resolved.auth.headers);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async discover(value: unknown): Promise<ModelDiscoveryResponse> {
    const request = parseModelDiscoveryRequest(value);
    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-webui-model-discovery-"));
      const temporaryModelsPath = join(temporaryDirectory, "models.json");
      await writeFile(temporaryModelsPath, JSON.stringify(modelsDocumentForDiscovery(request), null, 2), "utf8");

      const runtime = await this.createConnectionRuntime({ modelsPath: temporaryModelsPath, authPath: this.authPath });
      const loadError = runtime.getError();
      if (loadError !== undefined) throw new Error(loadError);

      const resolved = await runtime.getAuth(request.providerName);
      if (resolved === undefined) throw new Error(`No API key found for "${request.providerName}"`);

      const endpoint = modelDiscoveryEndpoint(request.provider.baseUrl, request.provider.api, resolved.auth.apiKey);
      const response = await fetchModels(endpoint, request.provider.api, resolved.auth.apiKey, resolved.auth.headers);
      if (!response.ok) throw new Error(`Model discovery request failed with HTTP ${String(response.status)}`);

      return { models: parseDiscoveredModels(await response.json(), request.provider.api) };
    } finally {
      if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async readStoredDocument(): Promise<StoredDocumentRead> {
    let content: string;
    try {
      content = await readFile(this.modelsPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { kind: "missing" };
      throw new ModelsConfigServiceError("MODELS_CONFIG_IO_FAILED", `Failed to read models.json: ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = parseModelsJsonText(content);
    } catch (error) {
      if (error instanceof ModelsJsonParseError) {
        throw new ModelsConfigServiceError("MODELS_CONFIG_PARSE_FAILED", `models.json could not be parsed: ${error.message}`);
      }
      throw error;
    }

    const shape = validateModelsConfigDraftShape(parsed);
    if (!shape.ok) throw new ModelsConfigServiceError("MODELS_CONFIG_PARSE_FAILED", `models.json could not be parsed: ${shape.message}`);
    return { kind: "document", document: shape.document };
  }

  private async persist(document: ModelsConfigDocument): Promise<void> {
    try {
      await writeModelsJsonAtomically(this.modelsPath, document);
    } catch (error) {
      throw new ModelsConfigServiceError("MODELS_CONFIG_PERSIST_FAILED", `Failed to persist models.json: ${errorMessage(error)}`);
    }
  }

  private async refreshAfterSave(document: ModelsConfigDocument): Promise<void> {
    const modelRuntime = this.modelRuntime;
    if (modelRuntime === undefined) return;
    try {
      const result = await modelRuntime.refresh({ allowNetwork: false });
      if (result.aborted) throw new Error("models.json refresh was aborted");
      const configurationError = narrowRefreshFailure(modelRuntime.getError(), document);
      if (configurationError !== undefined) throw new Error(configurationError);
    } catch (error) {
      const message = errorMessage(error);
      this.rateLimits?.reportLoadFailure(message);
      throw new ModelsConfigServiceError(
        "MODELS_CONFIG_REFRESH_FAILED",
        `models.json was saved, but the active model configuration could not be reloaded: ${message}`,
        { persisted: true },
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation, operation);
    this.operationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function emptyModelsConfigDocument(): ModelsConfigDocument {
  return { providers: {} };
}

/** One pure shape validator shared by read, save, and the save guard. */
export function validateModelsConfigDraftShape(
  value: unknown,
): { ok: true; document: ModelsConfigDocument } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: "models.json must be a JSON object" };
  const rawProviders = value["providers"];
  if (rawProviders === undefined) return { ok: true, document: { ...value, providers: {} } };
  if (!isRecord(rawProviders)) return { ok: false, message: "models.json providers must be an object" };

  const providers: Record<string, ModelsConfigProvider> = {};
  for (const [providerName, rawProvider] of Object.entries(rawProviders)) {
    if (!isRecord(rawProvider)) return { ok: false, message: `models.json provider "${providerName}" must be an object` };
    const rawModels = rawProvider["models"];
    if (rawModels !== undefined) {
      if (!Array.isArray(rawModels)) return { ok: false, message: `models.json provider "${providerName}" models must be an array` };
      for (const entry of rawModels) {
        if (!isRecord(entry)) return { ok: false, message: `models.json provider "${providerName}" model entries must be objects` };
        if (typeof entry["id"] !== "string") return { ok: false, message: `models.json provider "${providerName}" model entries must have a string id` };
      }
    }
    const provider: ModelsConfigProvider = {};
    for (const [key, entry] of Object.entries(rawProvider)) provider[key] = entry;
    providers[providerName] = provider;
  }
  return { ok: true, document: { ...value, providers } };
}

export function parseModelConnectionTestRequest(value: unknown): ModelConnectionTestRequest {
  if (!isRecord(value)) throw new Error("Model test request must be an object");
  const providerName = requiredTrimmedString(value, "providerName");
  const provider = requiredRecord(value, "provider");
  const model = requiredRecord(value, "model");
  const modelId = requiredTrimmedString(model, "id");
  return {
    providerName,
    provider: { ...provider },
    model: { ...model, id: modelId },
  };
}

export function parseModelDiscoveryRequest(value: unknown): ModelDiscoveryRequest {
  if (!isRecord(value)) throw new Error("Model discovery request must be an object");
  const providerName = requiredTrimmedString(value, "providerName");
  const provider = requiredRecord(value, "provider");
  return {
    providerName,
    provider: { ...provider, baseUrl: requiredTrimmedString(provider, "baseUrl") },
  };
}

function invalidLimitsError(error: ModelRateLimitValidationError | undefined): ModelsConfigServiceError {
  if (error === undefined) return new ModelsConfigServiceError("MODELS_CONFIG_INVALID_LIMITS", "models.json has invalid rate limits");
  return new ModelsConfigServiceError(
    "MODELS_CONFIG_INVALID_LIMITS",
    modelRateLimitFieldMessage(error.field, error.reason),
    {
      provider: error.provider,
      modelId: error.modelId,
      field: error.field,
      reason: error.reason,
      occurrence: error.occurrence,
    },
  );
}

function narrowRefreshFailure(error: string | undefined, document: ModelsConfigDocument): string | undefined {
  if (error === undefined || error === "") return undefined;
  const providerKeys = new Set(Object.keys(document.providers ?? {}));
  for (const line of error.split("\n")) {
    const trimmed = line.trim();
    if (MODEL_CONFIGURATION_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return trimmed;
    const match = /^Provider "([^"]+)":/u.exec(trimmed);
    if (match !== null && providerKeys.has(match[1] ?? "")) return trimmed;
  }
  return undefined;
}

async function writeModelsJsonAtomically(modelsPath: string, document: ModelsConfigDocument): Promise<void> {
  await mkdir(dirname(modelsPath), { recursive: true });
  const targetPath = await resolveModelsWriteTarget(modelsPath);
  await mkdir(dirname(targetPath), { recursive: true });

  const existing = await statIfExists(targetPath);
  if (existing !== undefined && existing.nlink > 1) {
    throw new Error("models.json has multiple hard links; refusing to replace one directory entry");
  }
  const mode = process.platform === "win32" || existing === undefined ? undefined : existing.mode & 0o7777;
  const temporaryPath = join(dirname(targetPath), `${basename(targetPath)}.${String(process.pid)}.${randomUUID()}.tmp`);

  let handle: FileHandle | undefined;
  try {
    handle = mode === undefined ? await open(temporaryPath, "w") : await open(temporaryPath, "w", mode);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveModelsWriteTarget(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return join(await realpath(dirname(filePath)), basename(filePath));
  }
}

async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function runModelConnectionTest(
  completeSimple: ModelCompletionFunction,
  model: NonNullable<ReturnType<ModelConnectionRuntime["getModel"]>>,
  apiKey: string,
  headers: Record<string, string | null> | undefined,
): Promise<ModelConnectionTestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, MODEL_CONNECTION_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let status: number | undefined;

  try {
    const message = await completeSimple(model, {
      messages: [{
        role: "user",
        content: "Reply with OK only.",
        timestamp: Date.now(),
      }],
    }, {
      apiKey,
      ...(headers === undefined ? {} : { headers }),
      maxTokens: 16,
      timeoutMs: MODEL_CONNECTION_TEST_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
      onResponse: (response) => { status = response.status; },
    });
    const latencyMs = Date.now() - startedAt;

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return {
        ok: false,
        error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
        latencyMs,
        ...(status === undefined ? {} : { status }),
      };
    }

    return {
      ok: true,
      latencyMs,
      ...(status === undefined ? {} : { status }),
      responseText: assistantText(message.content),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function modelsDocumentForConnectionTest(request: ModelConnectionTestRequest): ModelsConfigDocument {
  return {
    providers: {
      [request.providerName]: {
        ...request.provider,
        models: [{ ...request.model, id: request.model.id.trim() }],
      },
    },
  };
}

function modelsDocumentForDiscovery(request: ModelDiscoveryRequest): ModelsConfigDocument {
  return { providers: { [request.providerName]: providerWithoutModels(request.provider) } };
}

function providerWithoutModels(provider: ModelsConfigProvider): ModelsConfigProvider {
  const result: ModelsConfigProvider = {};
  for (const [name, value] of Object.entries(provider)) {
    if (name !== "models") result[name] = value;
  }
  return result;
}

async function createConnectionRuntimeForProfile(options: { modelsPath: string; authPath: string }): Promise<ModelConnectionRuntime> {
  return await ModelRuntime.create({
    modelsPath: options.modelsPath,
    authPath: options.authPath,
    // Isolated checks resolve the profile's credentials but do not refresh
    // unrelated provider catalogs before issuing their request.
    allowModelNetwork: false,
  });
}

function modelDiscoveryEndpoint(baseUrl: string | undefined, api: string | undefined, apiKey: string | undefined): URL {
  if (baseUrl === undefined) throw new Error("baseUrl is required");
  const endpointPath = api === "anthropic-messages" ? "v1/models" : "models";
  const endpoint = new URL(endpointPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("Provider base URL must use HTTP or HTTPS");
  if (api === "google-generative-ai") {
    if (apiKey === undefined || apiKey === "") throw new Error("No API key found for Google model discovery");
    endpoint.searchParams.set("key", apiKey);
  }
  return endpoint;
}

async function fetchModels(
  endpoint: URL,
  api: string | undefined,
  apiKey: string | undefined,
  configuredHeaders: Record<string, string | null> | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, MODEL_DISCOVERY_TIMEOUT_MS);
  const suppressedHeaders = new Set<string>();
  const headers = new Headers({ accept: "application/json" });

  for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
    if (value === null) {
      suppressedHeaders.add(name.toLowerCase());
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  if (api === "google-generative-ai") {
    // Google accepts the resolved key in the query string above.
  } else if (api === "anthropic-messages") {
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "x-api-key", apiKey);
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "anthropic-version", "2023-06-01");
  } else {
    setDefaultDiscoveryHeader(headers, suppressedHeaders, "authorization", apiKey === undefined || apiKey === "" ? undefined : `Bearer ${apiKey}`);
  }

  try {
    return await fetch(endpoint, { headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Model discovery timed out", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setDefaultDiscoveryHeader(headers: Headers, suppressedHeaders: ReadonlySet<string>, name: string, value: string | undefined): void {
  if (value === undefined || headers.has(name) || suppressedHeaders.has(name.toLowerCase())) return;
  headers.set(name, value);
}

function parseDiscoveredModels(value: unknown, api: string | undefined): ModelDiscoveryModel[] {
  const entries = modelDiscoveryEntries(value);
  const models: ModelDiscoveryModel[] = [];
  const knownIds = new Set<string>();

  for (const entry of entries) {
    const model = parseDiscoveredModel(entry, api);
    if (model === undefined || knownIds.has(model.id)) continue;
    knownIds.add(model.id);
    models.push(model);
  }
  return models;
}

function modelDiscoveryEntries(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw new Error("Model discovery response must be an object or array");
  const data = value["data"];
  if (Array.isArray(data)) return data;
  const models = value["models"];
  if (Array.isArray(models)) return models;
  throw new Error("Model discovery response did not contain a model list");
}

function parseDiscoveredModel(value: unknown, api: string | undefined): ModelDiscoveryModel | undefined {
  if (typeof value === "string") return discoveredModel(value);
  if (!isRecord(value)) return undefined;

  const rawId = typeof value["id"] === "string" ? value["id"] : value["name"];
  if (typeof rawId !== "string") return undefined;
  const id = api === "google-generative-ai" ? rawId.replace(/^models\//u, "") : rawId;
  const name = firstString(value["displayName"], value["display_name"], typeof value["id"] === "string" ? value["name"] : undefined);
  return discoveredModel(id, name);
}

function discoveredModel(id: string, name?: string): ModelDiscoveryModel | undefined {
  const trimmedId = id.trim();
  if (trimmedId === "") return undefined;
  const trimmedName = name?.trim();
  return trimmedName === undefined || trimmedName === "" || trimmedName === trimmedId
    ? { id: trimmedId }
    : { id: trimmedId, name: trimmedName };
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function assistantText(content: readonly unknown[]): string {
  return content
    .filter(isTextContent)
    .map((block) => block.text)
    .join("")
    .slice(0, 300);
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value["type"] === "text" && typeof value["text"] === "string";
}

function requiredTrimmedString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requiredRecord(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!isRecord(value)) throw new Error(`${field} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Implementation notes that must hold while retaining the existing tail:

- `runModelConnectionTest` keeps `MODEL_CONNECTION_TEST_TIMEOUT_MS`, `startedAt`, the `AbortController`, `onResponse` status capture, and the `ok`/`latencyMs`/`status`/`responseText` result shape; the listing above is the complete replacement and only the delegate call changed from `runtime.completeSimple(...)` to `completeSimple(...)`.
- `discover` and every helper in the tail are byte-for-byte the current implementations; the listing above is complete, so do not leave any placeholder comment behind.
- Delete `normalizeModelsConfigDocument` and `parseModelsConfigDocument`; they are replaced by `validateModelsConfigDraftShape` and are used nowhere else.

- [ ] **Step 4: Update `src/server/models/modelsConfigService.test.ts`**

In the first test, add `getError: () => undefined,` to the `modelRuntime` fake and change the assertion:

```ts
    await expect(models.save(config)).resolves.toEqual({ success: true, contractVersion: 1 });
```

- [ ] **Step 5: Wire the owner into `src/server/sessiond.ts`**

Add the import next to the models imports:

```ts
import { createModelRateLimitOwner } from "./rateLimits/modelRateLimitOwner.js";
```

Replace the auth/models construction lines with:

```ts
    const auth = await AuthService.create({ agentDir: activeAgentProfile.dir, logger: app.log });
    const rateLimits = createModelRateLimitOwner({ logger: app.log });
    const models = new ModelsConfigService({
      agentDir: activeAgentProfile.dir,
      modelRuntime: auth.runtime,
      rateLimits,
      logger: app.log,
    });
    await models.initialize();
```

Add `rateLimits` to the object returned by `createRuntime()`, change the `listen` destructure to `async listen({ auth, sessions, rateLimits, terminals, unreadStore })`, and add after `await attempt("dispose sessions", ...)`:

```ts
      await attempt("dispose model rate limits", () => { rateLimits.dispose(); });
```

- [ ] **Step 6: Run the focused tests and confirm they pass**

Run: `npm test -- --run src/server/models/modelsConfigService.rateLimits.test.ts src/server/models/modelsConfigService.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/server/models/modelsConfigService.ts src/server/models/modelsConfigService.test.ts src/server/models/modelsConfigService.rateLimits.test.ts src/server/sessiond.ts
git commit -m "feat(models): persist, validate, and publish rate limit snapshots"
```

## Task 9: Models-config route contract

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/models/modelsConfigRoutes.ts:1-42`
- Test: `src/server/models/modelsConfigRoutes.test.ts`

**Interfaces:**

- Consumes: `ModelsConfigServiceError` from Task 8; `ModelsConfigDocument`, `ModelsConfigErrorCode`, `ModelsConfigErrorResponse`, `ModelsConfigLimitsStatusResponse`, `ModelsConfigSaveResponse`, `ModelConnectionTestResponse`, `ModelDiscoveryResponse` from Task 7.
- Produces: `interface ModelsConfigRouteService` with `read()`, `readLimitsStatus()`, `save(value)`, `test(value)`, `discover(value)`;
  `registerModelsConfigRoutes(app: FastifyInstance, models: ModelsConfigRouteService, prefix = ""): void`;
  `modelsConfigErrorBody(error: ModelsConfigServiceError): ModelsConfigErrorResponse`.

- [ ] **Step 1: Write the failing test**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsConfigErrorCode } from "../../shared/apiTypes";
import { ModelsConfigServiceError } from "./modelsConfigService";
import { registerModelsConfigRoutes, type ModelsConfigRouteService } from "./modelsConfigRoutes";

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

function routeService(overrides: Partial<ModelsConfigRouteService> = {}): ModelsConfigRouteService {
  return {
    read: vi.fn().mockResolvedValue({ providers: {} }),
    readLimitsStatus: vi.fn().mockReturnValue({ contractVersion: 1, revision: 0, admission: "ready", source: "none" }),
    save: vi.fn().mockResolvedValue({ success: true, contractVersion: 1, revision: 1 }),
    test: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    discover: vi.fn().mockResolvedValue({ models: [] }),
    ...overrides,
  };
}

describe("models-config routes", () => {
  it("returns a bare document on read and the additive save response", async () => {
    const document = { providers: { acme: { models: [{ id: "demo", tpm: 10 }] } } };
    registerModelsConfigRoutes(app, routeService({ read: vi.fn().mockResolvedValue(document) }));

    const read = await app.inject({ method: "GET", url: "/models-config" });
    const save = await app.inject({ method: "PUT", url: "/models-config", payload: { providers: {} } });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(document);
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({ success: true, contractVersion: 1, revision: 1 });
  });

  it("returns the limits sidecar shape including an optional error", async () => {
    registerModelsConfigRoutes(app, routeService({
      readLimitsStatus: vi.fn().mockReturnValue({ contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" }),
    }));

    const response = await app.inject({ method: "GET", url: "/models-config/limits" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ contractVersion: 1, revision: 2, admission: "blocked", source: "none", error: "bad file" });
  });

  it.each<{ code: ModelsConfigErrorCode; status: number }>([
    { code: "MODELS_CONFIG_PARSE_FAILED", status: 422 },
    { code: "MODELS_CONFIG_IO_FAILED", status: 500 },
    { code: "MODELS_CONFIG_SAVE_INVALID", status: 400 },
    { code: "MODELS_CONFIG_INVALID_LIMITS", status: 400 },
    { code: "MODELS_CONFIG_UNREADABLE", status: 409 },
    { code: "MODELS_CONFIG_PERSIST_FAILED", status: 500 },
    { code: "MODELS_CONFIG_REFRESH_FAILED", status: 502 },
    { code: "MODELS_CONFIG_INTERNAL", status: 500 },
  ])("maps $code to HTTP $status with structured fields", async ({ code, status }) => {
    const error = new ModelsConfigServiceError(code, `message for ${code}`, {
      provider: "acme",
      modelId: "demo",
      field: "tpm",
      reason: "negative",
      occurrence: 0,
      ...(code === "MODELS_CONFIG_REFRESH_FAILED" ? { persisted: true } : {}),
    });
    registerModelsConfigRoutes(app, routeService({ save: vi.fn().mockRejectedValue(error) }));

    const response = await app.inject({ method: "PUT", url: "/models-config", payload: { providers: {} } });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({
      error: `message for ${code}`,
      code,
      file: "models.json",
      provider: "acme",
      modelId: "demo",
      field: "tpm",
      reason: "negative",
      occurrence: 0,
      ...(code === "MODELS_CONFIG_REFRESH_FAILED" ? { persisted: true } : {}),
    });
  });

  it("maps an unexpected failure to MODELS_CONFIG_INTERNAL", async () => {
    registerModelsConfigRoutes(app, routeService({ read: vi.fn().mockRejectedValue(new Error("boom")) }));

    const response = await app.inject({ method: "GET", url: "/models-config" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Models configuration operation failed.", code: "MODELS_CONFIG_INTERNAL", file: "models.json" });
  });

  it("keeps the connection test and discovery response shapes unchanged", async () => {
    registerModelsConfigRoutes(app, routeService({
      test: vi.fn().mockResolvedValue({ ok: false, error: "no key", latencyMs: 12, status: 401 }),
      discover: vi.fn().mockResolvedValue({ models: [{ id: "gpt-test", name: "GPT Test" }] }),
    }));

    const testResponse = await app.inject({ method: "POST", url: "/models-config/test", payload: {} });
    const discoverResponse = await app.inject({ method: "POST", url: "/models-config/discover", payload: {} });

    expect(testResponse.statusCode).toBe(400);
    expect(testResponse.json()).toEqual({ ok: false, error: "no key", latencyMs: 12, status: 401 });
    expect(discoverResponse.statusCode).toBe(200);
    expect(discoverResponse.json()).toEqual({ models: [{ id: "gpt-test", name: "GPT Test" }] });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/models/modelsConfigRoutes.test.ts`
Expected: FAIL, `Cannot find module './modelsConfigRoutes.test'` dependency on `ModelsConfigRouteService` and the sidecar route.

- [ ] **Step 3: Rewrite `src/server/models/modelsConfigRoutes.ts`**

```ts
import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ModelConnectionTestResponse,
  ModelDiscoveryResponse,
  ModelsConfigDocument,
  ModelsConfigErrorCode,
  ModelsConfigErrorResponse,
  ModelsConfigLimitsStatusResponse,
  ModelsConfigSaveResponse,
} from "../../shared/apiTypes.js";
import { ModelsConfigServiceError } from "./modelsConfigService.js";

/** Narrow surface the routes need; `ModelsConfigService` satisfies it. */
export interface ModelsConfigRouteService {
  read(): Promise<ModelsConfigDocument>;
  readLimitsStatus(): ModelsConfigLimitsStatusResponse;
  save(value: unknown): Promise<ModelsConfigSaveResponse>;
  test(value: unknown): Promise<ModelConnectionTestResponse>;
  discover(value: unknown): Promise<ModelDiscoveryResponse>;
}

const HTTP_STATUS_BY_CODE: Record<ModelsConfigErrorCode, number> = {
  MODELS_CONFIG_PARSE_FAILED: 422,
  MODELS_CONFIG_IO_FAILED: 500,
  MODELS_CONFIG_SAVE_INVALID: 400,
  MODELS_CONFIG_INVALID_LIMITS: 400,
  MODELS_CONFIG_UNREADABLE: 409,
  MODELS_CONFIG_PERSIST_FAILED: 500,
  MODELS_CONFIG_REFRESH_FAILED: 502,
  MODELS_CONFIG_INTERNAL: 500,
};

/** Register daemon-owned models.json editing and connection-test endpoints. */
export function registerModelsConfigRoutes(app: FastifyInstance, models: ModelsConfigRouteService, prefix = ""): void {
  app.get(`${prefix}/models-config`, async (_request, reply) => {
    try {
      return await models.read();
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.get(`${prefix}/models-config/limits`, async (_request, reply) => {
    try {
      return models.readLimitsStatus();
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.put<{ Body: unknown }>(`${prefix}/models-config`, async (request, reply) => {
    try {
      return await models.save(request.body);
    } catch (error) {
      return sendModelsConfigError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/models-config/test`, async (request, reply) => {
    try {
      const result = await models.test(request.body);
      return await reply.code(result.ok ? 200 : 400).send(result);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/models-config/discover`, async (request, reply) => {
    try {
      return await models.discover(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

/** Builds the additive structured error body, keeping the legacy `error` string. */
export function modelsConfigErrorBody(error: ModelsConfigServiceError): ModelsConfigErrorResponse {
  return { error: error.message, code: error.code, file: "models.json", ...error.details };
}

function sendModelsConfigError(reply: FastifyReply, error: unknown): FastifyReply {
  const structured = error instanceof ModelsConfigServiceError
    ? error
    : new ModelsConfigServiceError("MODELS_CONFIG_INTERNAL", "Models configuration operation failed.");
  return reply.code(HTTP_STATUS_BY_CODE[structured.code]).send(modelsConfigErrorBody(structured));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/server/models/modelsConfigRoutes.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS (`ModelsConfigService` structurally satisfies `ModelsConfigRouteService`).

```bash
git add src/server/models/modelsConfigRoutes.ts src/server/models/modelsConfigRoutes.test.ts
git commit -m "feat(models): map structured models-config failures to HTTP contracts"
```

## Task 10: Session runtime stream wrapping

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:1013-1075,1119-1125,1367-1400`
- Modify: `src/server/sessions/piSessionService.promptQueue.test.ts:376-385`
- Modify: `src/server/sessiond.ts:117-133`
- Test: `src/server/sessions/piSessionService.rateLimits.test.ts`

**Interfaces:**

- Consumes: `wrapModelStream(owner, delegate)` from Task 5; `createModelRateLimitOwner`, `type ModelRateLimitOwner`, `MODEL_RATE_LIMITS_BLOCKED_MESSAGE` from Task 4; `createDefaultRuntimeFactory`, `type PiSessionServiceDependencies` from `src/server/sessions/piSessionService.ts`; `createFakeModelRateLimitClock`, `fixtureIdentity`, `fixtureLimits`, `fixtureSnapshot`, `fixtureTerminalMessage` from Task 4's test support.
- Produces: `createDefaultRuntimeFactory(modelRuntime, sessionManagers, utilityModelResolver, logger, spawn?, subsessions?, modelPolicy?, modelRateLimitOwner?: ModelRateLimitOwner, sdk?)`, wrapping `result.session.agent.streamFunction` and publishing the same wrapped function through `runtimeRefs.streamFunction` after `createFromServices` returns; `PiSessionServiceDependencies.modelRateLimitOwner?: ModelRateLimitOwner`.

- [ ] **Step 1: Write the failing test**

```ts
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  type SessionBeforeTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MODEL_RATE_LIMITS_BLOCKED_MESSAGE, createModelRateLimitOwner, type ModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import { wrapModelStream } from "../rateLimits/modelRateLimitAdapters";
import {
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "../rateLimits/modelRateLimitTestSupport";
import { createDefaultRuntimeFactory } from "./piSessionService";
import { fakeAgentSessionServices, fakeRuntime, sessionGateway, testModel, testModelRuntime } from "./piSessionService.testSupport";

const TEST_AGENT_DIR = "/tmp/pi-webui-test-agent";
const identity = fixtureIdentity("anthropic", "demo-model");
const candidateIdentity = fixtureIdentity("anthropic", "utility-lightweight");

function completedStream(input: number): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const base = fixtureTerminalMessage({ api: model.api, provider: model.provider, model: model.id });
    const message: AssistantMessage = fixtureTerminalMessage({
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...base.usage, input, totalTokens: input },
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
}

function makeFactory(owner: ModelRateLimitOwner, delegate: StreamFn) {
  const streamFunction = vi.fn<StreamFn>((model, context, options) => delegate(model, context, options));
  const fake = fakeRuntime("limited-session", { agent: { streamFunction } });
  const services = fakeAgentSessionServices();
  const createServices = vi.fn<typeof createAgentSessionServices>(() => Promise.resolve(services));
  // The SDK session class has private state; this host-surface fake is the tested adapter boundary.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const createdSession = fake.session as unknown as Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
  const createFromServices = vi.fn<typeof createAgentSessionFromServices>(() => Promise.resolve({
    session: createdSession,
    extensionsResult: services.resourceLoader.getExtensions(),
  }));
  return {
    streamFunction,
    createServices,
    factory: createDefaultRuntimeFactory(
      testModelRuntime,
      sessionGateway([]),
      { configuredCandidates: vi.fn().mockResolvedValue([]) },
      { info: vi.fn() },
      undefined,
      undefined,
      undefined,
      owner,
      { createServices, createFromServices },
    ),
  };
}

async function createRuntimeSession(factory: ReturnType<typeof createDefaultRuntimeFactory>) {
  return await factory({
    cwd: process.cwd(),
    agentDir: TEST_AGENT_DIR,
    sessionManager: SessionManager.inMemory(process.cwd()),
    delegationToolsEnabled: false,
  });
}

describe("PiSessionService rate limit integration", () => {
  it("shares one model budget across independently created sessions and charges once per call", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");
    const sessionA = makeFactory(owner, completedStream(0));
    const sessionB = makeFactory(owner, completedStream(0));
    const model = { ...testModel(), id: "demo-model" };
    const context = { messages: [] };

    const first = await createRuntimeSession(sessionA.factory);
    const second = await createRuntimeSession(sessionB.factory);

    expect(first.session.agent.streamFunction).not.toBe(sessionA.streamFunction);
    await expect(first.session.agent.streamFunction(model, context, {}).result()).resolves.toMatchObject({ stopReason: "stop" });
    const queued = second.session.agent.streamFunction(model, context, {}).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    clock.advance(60_000);
    await expect(queued).resolves.toMatchObject({ stopReason: "stop" });
    expect(sessionA.streamFunction).toHaveBeenCalledTimes(1);
    expect(sessionB.streamFunction).toHaveBeenCalledTimes(1);
  });

  it("re-wraps each replacement runtime without double wrapping", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    const sessionA = makeFactory(owner, completedStream(0));
    const sessionB = makeFactory(owner, completedStream(0));

    const first = await createRuntimeSession(sessionA.factory);
    const second = await createRuntimeSession(sessionB.factory);

    expect(first.session.agent.streamFunction).not.toBe(second.session.agent.streamFunction);
    expect(wrapModelStream(owner, first.session.agent.streamFunction)).toBe(first.session.agent.streamFunction);
    await expect(first.session.agent.streamFunction(testModel(), { messages: [] }, {}).result()).resolves.toMatchObject({ stopReason: "stop" });
    expect(sessionA.streamFunction).toHaveBeenCalledTimes(1);
  });

  it("charges the branch-summary utility candidate model", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "utility-lightweight": fixtureLimits(5) } }), "accepted-document");
    const candidate = { ...testModel(), id: "utility-lightweight" };
    const streamFunction = vi.fn<StreamFn>(completedStream(5));
    const fake = fakeRuntime("utility-session", { agent: { streamFunction }, model: testModel() });
    const services = fakeAgentSessionServices();
    const createServices = vi.fn<typeof createAgentSessionServices>(() => Promise.resolve(services));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const createdSession = fake.session as unknown as Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
    const createFromServices = vi.fn<typeof createAgentSessionFromServices>(() => Promise.resolve({
      session: createdSession,
      extensionsResult: services.resourceLoader.getExtensions(),
    }));
    const factory = createDefaultRuntimeFactory(
      testModelRuntime,
      sessionGateway([]),
      { configuredCandidates: vi.fn().mockResolvedValue([{ model: candidate, thinkingLevel: "high", slot: "lightweight" }]) },
      { info: vi.fn() },
      undefined,
      undefined,
      undefined,
      owner,
      { createServices, createFromServices },
    );

    await createRuntimeSession(factory);

    const extensionFactories = createServices.mock.calls[0]?.[0].resourceLoaderOptions?.extensionFactories;
    if (extensionFactories === undefined) throw new Error("Expected utility extension factory");
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: TEST_AGENT_DIR,
      settingsManager: services.settingsManager,
      extensionFactories,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const beforeTree = loader.getExtensions().extensions[0]?.handlers.get("session_before_tree")?.[0];
    if (beforeTree === undefined) throw new Error("Expected utility tree handler");

    await beforeTree(treeEvent(), { model: testModel() });

    expect(streamFunction.mock.calls[0]?.[0]).toBe(candidate);
    const followUp = owner.acquire(candidateIdentity);
    expect(owner.pendingWaiterCount(candidateIdentity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("removes a queued stream waiter when the session call is aborted", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ anthropic: { "demo-model": fixtureLimits(undefined, 1) } }), "accepted-document");
    const session = makeFactory(owner, completedStream(0));
    const runtime = await createRuntimeSession(session.factory);
    const model = { ...testModel(), id: "demo-model" };
    await owner.acquire(identity);
    const controller = new AbortController();

    const queued = runtime.session.agent.streamFunction(model, { messages: [] }, { signal: controller.signal }).result();
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    controller.abort();

    await expect(queued).resolves.toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    expect(session.streamFunction).not.toHaveBeenCalled();
  });

  it("fails sessions closed with the structured terminal when no snapshot was accepted", async () => {
    const owner = createModelRateLimitOwner({ clock: createFakeModelRateLimitClock() });
    owner.reportLoadFailure("models.json could not be parsed: bad");
    const session = makeFactory(owner, completedStream(0));
    const runtime = await createRuntimeSession(session.factory);

    const message = await runtime.session.agent.streamFunction(testModel(), { messages: [] }, {}).result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(`${MODEL_RATE_LIMITS_BLOCKED_MESSAGE} models.json could not be parsed: bad`);
    expect(session.streamFunction).not.toHaveBeenCalled();
  });
});

function treeEvent(): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId: "target-entry",
      oldLeafId: "branch-entry",
      commonAncestorId: null,
      entriesToSummarize: [{
        type: "custom_message",
        id: "branch-entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "rate-limit-test",
        content: "Verify utility routing",
        display: false,
      }],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  };
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/sessions/piSessionService.rateLimits.test.ts`
Expected: FAIL: `createDefaultRuntimeFactory` has no owner parameter and no wrapping exists.

- [ ] **Step 3: Modify `src/server/sessions/piSessionService.ts`**

Add imports near the existing rate-limit-adjacent imports:

```ts
import { wrapModelStream } from "../rateLimits/modelRateLimitAdapters.js";
import type { ModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner.js";
```

Change the `createDefaultRuntimeFactory` signature to insert the optional owner before the `sdk` seam:

```ts
export function createDefaultRuntimeFactory(
  modelRuntime: ModelRuntime,
  sessionManagers: Pick<PiSessionManagerGateway, "open">,
  utilityModelResolver: UtilityModelResolver<AgentModel>,
  logger: PiSessionLogger,
  spawn?: SpawnSessionFn,
  subsessions?: SubsessionToolDeps,
  modelPolicy?: ModelPolicyToolDeps,
  modelRateLimitOwner?: ModelRateLimitOwner,
  sdk: PiWebUiAgentSessionSdk = {
    createServices: createAgentSessionServices,
    createFromServices: createAgentSessionFromServices,
  }
): PiWebUiCreateAgentSessionRuntimeFactory {
```

Replace the two lines `runtimeRefs.streamFunction = result.session.agent.streamFunction;` and `return { ...result, services, diagnostics: services.diagnostics };` with:

```ts
    const delegateStreamFunction = result.session.agent.streamFunction;
    const limitedStreamFunction = modelRateLimitOwner === undefined
      ? delegateStreamFunction
      : wrapModelStream(modelRateLimitOwner, delegateStreamFunction);
    result.session.agent.streamFunction = limitedStreamFunction;
    runtimeRefs.streamFunction = limitedStreamFunction;
    return { ...result, services, diagnostics: services.diagnostics };
```

Add to `PiSessionServiceDependencies` after `utilityModelResolver?: UtilityModelResolver<AgentModel>;`:

```ts
  /** Daemon-owned limiter applied to every session stream call. */
  modelRateLimitOwner?: ModelRateLimitOwner;
```

In the `PiSessionService` constructor, add `deps.modelRateLimitOwner` as the new argument immediately before the `sdk` object in the existing `createDefaultRuntimeFactory(...)` call (after the `modelPolicy` argument).

- [ ] **Step 4: Update `src/server/sessions/piSessionService.promptQueue.test.ts`**

Insert one `undefined,` argument before `{ createServices, createFromServices },` in the `createDefaultRuntimeFactory(...)` call so the sdk object stays in the last position.

- [ ] **Step 5: Pass the owner in `src/server/sessiond.ts`**

Add `modelRateLimitOwner: rateLimits,` to the `new PiSessionService(eventHub, { ... })` dependencies object.

- [ ] **Step 6: Run the focused tests**

Run: `npm test -- --run src/server/sessions/piSessionService.rateLimits.test.ts src/server/sessions/piSessionService.promptQueue.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/piSessionService.rateLimits.test.ts src/server/sessiond.ts
git commit -m "feat(sessions): route session model calls through the rate limit owner"
```

## Task 11: Speech polishing completion wiring

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessiond.ts:44-48,102-105`
- Test: `src/server/speechInput/speechInputPolishingService.rateLimits.test.ts`

**Interfaces:**

- Consumes: `wrapModelCompletion(owner, delegate)` from Task 5; `createModelRateLimitOwner` from Task 4; `createSpeechInputPolishingService(dependencies)` and `SpeechInputPolishingService.polish(text, signal?)` from `src/server/speechInput/speechInputPolishingService.ts`; test support from Task 4.
- Produces: production wiring only: speech polishing receives `modelRuntime: { completeSimple: wrapModelCompletion(rateLimits, (model, context, options) => auth.runtime.completeSimple(model, context, options)) }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { wrapModelCompletion } from "../rateLimits/modelRateLimitAdapters";
import { createModelRateLimitOwner } from "../rateLimits/modelRateLimitOwner";
import {
  createFakeModelRateLimitClock,
  fixtureIdentity,
  fixtureLimits,
  fixtureSnapshot,
  fixtureTerminalMessage,
} from "../rateLimits/modelRateLimitTestSupport";
import { createSpeechInputPolishingService } from "./speechInputPolishingService";

const identity = fixtureIdentity("acme", "lightweight");
const model = {
  id: "lightweight",
  name: "Lightweight",
  api: "anthropic-messages" as const,
  provider: "acme",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function polishedMessage(input: number) {
  const base = fixtureTerminalMessage({ api: model.api, provider: model.provider, model: model.id });
  return fixtureTerminalMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text", text: "polished text" }],
    usage: { ...base.usage, input, totalTokens: input },
  });
}

function candidateResolver() {
  return { configuredCandidates: vi.fn().mockResolvedValue([{ model, thinkingLevel: "off", slot: "lightweight" }]) };
}

describe("speech input polishing rate limit integration", () => {
  it("charges the actual candidate model through the injected completion adapter", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ acme: { lightweight: fixtureLimits(5) } }), "accepted-document");
    const completeSimple = vi.fn(() => Promise.resolve(polishedMessage(5)));
    const service = createSpeechInputPolishingService({
      modelRuntime: { completeSimple: wrapModelCompletion(owner, completeSimple) },
      utilityModelResolver: candidateResolver(),
    });

    await expect(service.polish("hello")).resolves.toBe("polished text");

    const followUp = owner.acquire(identity);
    expect(owner.pendingWaiterCount(identity)).toBe(1);
    owner.dispose();
    await expect(followUp).resolves.toEqual({ status: "aborted" });
  });

  it("preserves the route deadline while queued and never dispatches after abort", async () => {
    const clock = createFakeModelRateLimitClock();
    const owner = createModelRateLimitOwner({ clock });
    owner.applySnapshot(fixtureSnapshot({ acme: { lightweight: fixtureLimits(undefined, 1) } }), "accepted-document");
    const completeSimple = vi.fn(() => Promise.resolve(polishedMessage(0)));
    const service = createSpeechInputPolishingService({
      modelRuntime: { completeSimple: wrapModelCompletion(owner, completeSimple) },
      utilityModelResolver: candidateResolver(),
    });
    await owner.acquire(identity);
    const controller = new AbortController();

    const polishing = service.polish("hello", controller.signal);
    await vi.waitFor(() => { expect(owner.pendingWaiterCount(identity)).toBe(1); });
    controller.abort();

    await expect(polishing).rejects.toMatchObject({ code: "SPEECH_INPUT_POLISHING_ABORTED" });
    expect(completeSimple).not.toHaveBeenCalled();
    expect(owner.pendingWaiterCount(identity)).toBe(0);
    clock.advance(60_000);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/server/speechInput/speechInputPolishingService.rateLimits.test.ts`
Expected: FAIL only if the adapter or service wiring is wrong; this test compiles against Tasks 4-5, so run it to prove the adapter path before touching `sessiond.ts`.

- [ ] **Step 3: Wire the adapter in `src/server/sessiond.ts`**

Add next to the sessiond imports:

```ts
import { wrapModelCompletion } from "./rateLimits/modelRateLimitAdapters.js";
```

Replace the existing `createSpeechInputPolishingService({ modelRuntime: auth.runtime, utilityModelResolver })` call with:

```ts
    const rateLimitsCompletion = wrapModelCompletion(
      rateLimits,
      (model, context, options) => auth.runtime.completeSimple(model, context, options),
    );
    const speechInputPolishing = createSpeechInputPolishingService({
      modelRuntime: { completeSimple: rateLimitsCompletion },
      utilityModelResolver,
    });
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npm test -- --run src/server/speechInput/speechInputPolishingService.rateLimits.test.ts`
Expected: PASS, 2 tests.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sessiond.ts src/server/speechInput/speechInputPolishingService.rateLimits.test.ts
git commit -m "feat(speech): charge polishing completions against the rate limit owner"
```

## Task 12: Client API for limits status and structured errors

**Implementer tier:** Standard

**Files:**

- Create: `src/client/src/api/modelsConfigError.ts`
- Modify: `src/client/src/api/parsers.ts:1042-1135`
- Modify: `src/client/src/api/clients.ts:16,263-273`
- Modify: `src/client/src/api.ts:1-5`
- Test: `src/client/src/api/parsers.modelsConfig.test.ts:1-51`
- Test: `src/client/src/api/clients.test.ts:409-431`

**Interfaces:**

- Consumes: `HttpRequestError`, `requestJson` from `src/client/src/api/http.ts`; `ModelsConfigErrorCode`, `ModelsConfigLimitsStatusResponse`, `ModelsConfigSaveResponse` from Task 7; `ModelRateLimitField`, `ModelRateLimitInvalidReason` from Task 1.
- Produces: `class ModelsConfigRequestError extends HttpRequestError` with `readonly details: ModelsConfigRequestErrorDetails`;
  `interface ModelsConfigRequestErrorDetails { code?: ModelsConfigErrorCode; file?: string; provider?: string; modelId?: string; field?: ModelRateLimitField; occurrence?: number; reason?: ModelRateLimitInvalidReason; persisted?: boolean }`;
  `modelsConfigErrorFromBody(body: unknown, status: number, fallbackMessage: string): ModelsConfigRequestError`;
  `modelsConfigApi.limitsStatus(machineId?: string): Promise<ModelsConfigLimitsStatusResponse>`;
  `parseModelsConfigLimitsStatusResponse(value: unknown): ModelsConfigLimitsStatusResponse`;
  `parseModelsConfigDocument` typing `tpm`/`prm` when numeric while preserving other raw values;
  `parseModelsConfigSaveResponse` accepting optional `contractVersion === 1` and numeric `revision`.

- [ ] **Step 1: Write the failing tests**

Add to `src/client/src/api/parsers.modelsConfig.test.ts`:

```ts
import { parseModelsConfigLimitsStatusResponse, parseModelsConfigSaveResponse } from "./parsers";

// inside the existing describe block:
  it("types numeric tpm/prm while preserving invalid stored values", () => {
    const parsed = parseModelsConfigDocument({
      providers: { acme: { models: [{ id: "demo", tpm: 100, prm: "bad" }] } },
    });

    expect(parsed.providers?.["acme"]?.models?.[0]?.tpm).toBe(100);
    expect(parsed.providers?.["acme"]?.models?.[0]?.["prm"]).toBe("bad");
  });

  it("parses the strict limits status sidecar", () => {
    expect(parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 2, admission: "ready", source: "accepted-document" }))
      .toEqual({ contractVersion: 1, revision: 2, admission: "ready", source: "accepted-document" });
    expect(parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "blocked", source: "none", error: "bad" }))
      .toEqual({ contractVersion: 1, revision: 0, admission: "blocked", source: "none", error: "bad" });
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "ready", source: "none", extra: true })).toThrow("Unexpected");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 2, revision: 0, admission: "ready", source: "none" })).toThrow("contract version");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "maybe", source: "none" })).toThrow("admission");
    expect(() => parseModelsConfigLimitsStatusResponse({ contractVersion: 1, revision: 0, admission: "ready", source: "nowhere" })).toThrow("source");
  });

  it("parses the additive save response revision", () => {
    expect(parseModelsConfigSaveResponse({ success: true })).toEqual({ success: true });
    expect(parseModelsConfigSaveResponse({ success: true, contractVersion: 1, revision: 4 }))
      .toEqual({ success: true, contractVersion: 1, revision: 4 });
    expect(() => parseModelsConfigSaveResponse({ success: true, contractVersion: 2 })).toThrow("contract version");
  });
```

Add to the `describe("Models configuration API")` block in `src/client/src/api/clients.test.ts`:

```ts
  it("reads the limits sidecar through the nested-deployment machine route", async () => {
    vi.stubEnv("BASE_URL", "./");
    vi.stubGlobal("document", { baseURI: "https://pi.example.test/nested/pi-webui/" });
    const fetchMock = stubJsonFetch({ contractVersion: 1, revision: 2, admission: "ready", source: "accepted-document" });

    await expect(modelsConfigApi.limitsStatus("remote /?")).resolves.toEqual({
      contractVersion: 1,
      revision: 2,
      admission: "ready",
      source: "accepted-document",
    });

    const [url] = fetchCall(fetchMock, 0);
    expect(new URL(url).pathname).toBe("/nested/pi-webui/api/machines/remote%20%2F%3F/models-config/limits");
  });

  it("throws a structured models configuration error for a failed save and parses a successful revision", async () => {
    const body = {
      error: "Tokens per minute must be a whole number.",
      code: "MODELS_CONFIG_INVALID_LIMITS",
      file: "models.json",
      provider: "acme",
      modelId: "demo",
      field: "tpm",
      occurrence: 0,
      reason: "not-a-number",
    };
    stubJsonFetch(body, 400);

    await expect(modelsConfigApi.save({ providers: {} })).rejects.toMatchObject({
      name: "ModelsConfigRequestError",
      status: 400,
      message: body.error,
      details: {
        code: "MODELS_CONFIG_INVALID_LIMITS",
        file: "models.json",
        provider: "acme",
        modelId: "demo",
        field: "tpm",
        occurrence: 0,
        reason: "not-a-number",
      },
    });

    stubJsonFetch({ success: true, contractVersion: 1, revision: 7 });
    await expect(modelsConfigApi.save({ providers: {} })).resolves.toEqual({ success: true, contractVersion: 1, revision: 7 });
  });
```

If `stubJsonFetch` has no status parameter in `clients.test.ts`, use the existing `stubSequenceFetch` with `new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } })`; `stubSequenceFetch` and `jsonResponse` are already defined there.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/api/parsers.modelsConfig.test.ts src/client/src/api/clients.test.ts`
Expected: FAIL, missing `parseModelsConfigLimitsStatusResponse`, `modelsConfigApi.limitsStatus`, and `ModelsConfigRequestError`.

- [ ] **Step 3: Create `src/client/src/api/modelsConfigError.ts`**

```ts
import type { ModelsConfigErrorCode } from "../../../shared/apiTypes";
import type { ModelRateLimitField, ModelRateLimitInvalidReason } from "../../../shared/modelRateLimits";
import { HttpRequestError } from "./http";

export interface ModelsConfigRequestErrorDetails {
  code?: ModelsConfigErrorCode;
  file?: string;
  provider?: string;
  modelId?: string;
  field?: ModelRateLimitField;
  occurrence?: number;
  reason?: ModelRateLimitInvalidReason;
  persisted?: boolean;
}

/** Structured models-config failure thrown by `modelsConfigApi.save`. */
export class ModelsConfigRequestError extends HttpRequestError {
  readonly details: ModelsConfigRequestErrorDetails;

  constructor(message: string, status: number, details: ModelsConfigRequestErrorDetails = {}) {
    super(message, status);
    this.name = "ModelsConfigRequestError";
    this.details = details;
  }
}

const ERROR_CODES: readonly ModelsConfigErrorCode[] = [
  "MODELS_CONFIG_PARSE_FAILED",
  "MODELS_CONFIG_IO_FAILED",
  "MODELS_CONFIG_SAVE_INVALID",
  "MODELS_CONFIG_INVALID_LIMITS",
  "MODELS_CONFIG_UNREADABLE",
  "MODELS_CONFIG_PERSIST_FAILED",
  "MODELS_CONFIG_REFRESH_FAILED",
  "MODELS_CONFIG_INTERNAL",
];

const REASONS: readonly ModelRateLimitInvalidReason[] = [
  "not-a-number",
  "not-finite",
  "not-an-integer",
  "negative",
  "unsafe-integer",
  "missing-model-id",
];

/** Accepts the structured body when present and always falls back to the `error` string. */
export function modelsConfigErrorFromBody(body: unknown, status: number, fallbackMessage: string): ModelsConfigRequestError {
  const record = isRecord(body) ? body : {};
  const message = typeof record["error"] === "string" && record["error"] !== "" ? record["error"] : fallbackMessage;
  return new ModelsConfigRequestError(message, status, structuredDetails(record));
}

function structuredDetails(record: Record<string, unknown>): ModelsConfigRequestErrorDetails {
  const details: ModelsConfigRequestErrorDetails = {};
  const code = record["code"];
  if (ERROR_CODES.includes(code as ModelsConfigErrorCode)) details.code = code as ModelsConfigErrorCode;
  if (typeof record["file"] === "string") details.file = record["file"];
  if (typeof record["provider"] === "string") details.provider = record["provider"];
  if (typeof record["modelId"] === "string") details.modelId = record["modelId"];
  const field = record["field"];
  if (field === "tpm" || field === "prm") details.field = field;
  if (typeof record["occurrence"] === "number") details.occurrence = record["occurrence"];
  const reason = record["reason"];
  if (REASONS.includes(reason as ModelRateLimitInvalidReason)) details.reason = reason as ModelRateLimitInvalidReason;
  if (typeof record["persisted"] === "boolean") details.persisted = record["persisted"];
  return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: Modify `src/client/src/api/parsers.ts`**

Add `type ModelsConfigLimitsStatusResponse` to the existing `../../shared/apiTypes` type import list.

In `parseModelsConfigModel`, after the `compat` block and before `return model;`, add:

```ts
  const tpm = record["tpm"];
  if (typeof tpm === "number") model.tpm = tpm;
  const prm = record["prm"];
  if (typeof prm === "number") model.prm = prm;
```

Replace `parseModelsConfigSaveResponse` with:

```ts
export function parseModelsConfigSaveResponse(value: unknown): ModelsConfigSaveResponse {
  const record = requireRecord(value);
  if (record["success"] !== true) throw new Error("Expected successful models configuration save");
  const contractVersion = record["contractVersion"];
  if (contractVersion !== undefined && contractVersion !== 1) {
    throw new Error("Expected models configuration save contract version 1");
  }
  const revision = record["revision"] === undefined ? undefined : requireNumber(record, "revision");
  return {
    success: true,
    ...(contractVersion === undefined ? {} : { contractVersion: 1 }),
    ...(revision === undefined ? {} : { revision }),
  };
}

export function parseModelsConfigLimitsStatusResponse(value: unknown): ModelsConfigLimitsStatusResponse {
  const record = requireRecord(value);
  const allowedKeys = new Set(["contractVersion", "revision", "admission", "source", "error"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) throw new Error(`Unexpected models configuration limits status key: ${key}`);
  }
  if (record["contractVersion"] !== 1) throw new Error("Expected models configuration limits status contract version 1");
  const revision = requireNumber(record, "revision");
  const admission = record["admission"];
  if (admission !== "ready" && admission !== "blocked") throw new Error("Expected models configuration limits admission state");
  const source = record["source"];
  if (source !== "none" && source !== "missing-file" && source !== "accepted-document" && source !== "last-known-good") {
    throw new Error("Expected models configuration limits source");
  }
  const error = optionalString(record, "error");
  return {
    contractVersion: 1,
    revision,
    admission,
    source,
    ...(error === undefined ? {} : { error }),
  };
}
```

- [ ] **Step 5: Modify `src/client/src/api/clients.ts`**

Change the `./http` import to `import { request, requestJson } from "./http";`, add `import { modelsConfigErrorFromBody } from "./modelsConfigError";`, and add `parseModelsConfigLimitsStatusResponse` to the existing `./parsers` import list.

Replace `modelsConfigApi` with:

```ts
export const modelsConfigApi = {
  config: (machineId = "local") => request(modelsConfigPath(machineId), parseModelsConfigDocument),
  limitsStatus: (machineId = "local") =>
    request(`${modelsConfigPath(machineId)}/limits`, parseModelsConfigLimitsStatusResponse),
  save: async (config: ModelsConfigDocument, machineId = "local"): Promise<ModelsConfigSaveResponse> => {
    const { status, body } = await requestJson(modelsConfigPath(machineId), {
      method: "PUT",
      body: JSON.stringify(config),
    });
    if (status < 200 || status >= 300) {
      throw modelsConfigErrorFromBody(body, status, "Failed to save models configuration.");
    }
    return parseModelsConfigSaveResponse(body);
  },
  test: (input: ModelConnectionTestRequest, machineId = "local") => request(`${modelsConfigPath(machineId)}/test`, parseModelConnectionTestResponse, { method: "POST", body: JSON.stringify(input) }),
  discover: (input: ModelDiscoveryRequest, machineId = "local") => request(`${modelsConfigPath(machineId)}/discover`, parseModelDiscoveryResponse, { method: "POST", body: JSON.stringify(input) }),
};
```

Add `ModelsConfigSaveResponse` to the shared type import list used by this block.

- [ ] **Step 6: Modify `src/client/src/api.ts`**

Add next to the existing `HttpRequestError` export:

```ts
export { ModelsConfigRequestError, modelsConfigErrorFromBody } from "./api/modelsConfigError";
export type { ModelsConfigRequestErrorDetails } from "./api/modelsConfigError";
```

Add `ModelsConfigErrorCode, ModelsConfigErrorResponse, ModelsConfigLimitsAdmission, ModelsConfigLimitsSource, ModelsConfigLimitsStatusResponse` to the large `../../shared/apiTypes` type re-export line.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/api/parsers.modelsConfig.test.ts src/client/src/api/clients.test.ts`
Expected: PASS, all tests in both files.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/client/src/api/modelsConfigError.ts src/client/src/api/parsers.ts src/client/src/api/clients.ts src/client/src/api.ts src/client/src/api/parsers.modelsConfig.test.ts src/client/src/api/clients.test.ts
git commit -m "feat(client): add limits status and structured models-config errors"
```

## Task 13: Client rate-limit draft helpers

**Implementer tier:** Standard

**Files:**

- Modify: `src/client/src/components/models/modelsConfigDraft.ts:1-145`
- Test: `src/client/src/components/models/modelsConfigDraft.test.ts:1-107`

**Interfaces:**

- Consumes: `MODEL_RATE_LIMIT_FIELDS`, `parseModelRateLimitStoredValue`, `parseModelRateLimitDraftText`, `modelRateLimitFieldMessage`, `type ModelRateLimitField` from Task 1; `ModelsConfigDocument`, `ModelsConfigModel` from `../../api`.
- Produces: `interface ModelRateLimitFieldDraft { text: string; loadedInvalidValue?: unknown; error?: string }`;
  `interface ModelRateLimitDraft { tpm: ModelRateLimitFieldDraft; prm: ModelRateLimitFieldDraft }`;
  `type ModelRateLimitDraftMap = Record<string, ModelRateLimitDraft>`;
  `rateLimitDraftKey(providerName: string, modelId: string, occurrence: number): string`;
  `modelRateLimitDraftsFromDocument(document: ModelsConfigDocument): ModelRateLimitDraftMap`;
  `applyRateLimitDraftField(draft: ModelRateLimitDraft, field: ModelRateLimitField, text: string): ModelRateLimitDraft`;
  `setModelRateLimitField(model: ModelsConfigModel, field: ModelRateLimitField, value: number | undefined): ModelsConfigModel`;
  `type RateLimitDraftReconciliationChange = { type: "rename"; providerName: string; from: string; to: string } | { type: "delete"; providerName: string; modelId: string; occurrence: number }`;
  `reconcileRateLimitDrafts(drafts: ModelRateLimitDraftMap, previousDocument: ModelsConfigDocument, nextDocument: ModelsConfigDocument, change?: RateLimitDraftReconciliationChange): ModelRateLimitDraftMap`;
  `firstInvalidRateLimitDraft(drafts: ModelRateLimitDraftMap): { key: string; providerName: string; modelId: string; field: ModelRateLimitField; message: string } | undefined`.

- [ ] **Step 1: Write the failing tests**

Append the following to the existing `describe("modelsConfigDraft", ...)` block in `src/client/src/components/models/modelsConfigDraft.test.ts`, and extend its import list from `./modelsConfigDraft`:

```ts
  it("encodes draft keys without separator collisions", () => {
    expect(rateLimitDraftKey("a/b", "c", 0)).toBe('["model-rate-limit-draft","a/b","c",0]');
    expect(rateLimitDraftKey("a", "b/c", 0)).not.toBe(rateLimitDraftKey("a/b", "c", 0));
  });

  it("derives drafts from valid and invalid stored values", () => {
    const drafts = modelRateLimitDraftsFromDocument({
      providers: { acme: { models: [
        { id: "valid", tpm: 100, prm: 0 },
        { id: "invalid", tpm: "bad" },
      ] } },
    });

    expect(drafts[rateLimitDraftKey("acme", "valid", 0)]).toEqual({ tpm: { text: "100" }, prm: { text: "0" } });
    expect(drafts[rateLimitDraftKey("acme", "invalid", 0)]).toEqual({
      tpm: { text: "", loadedInvalidValue: "bad", error: "Tokens per minute must be a whole number." },
      prm: { text: "" },
    });
  });

  it("applies valid, invalid, and blank draft text without trimming the stored text", () => {
    const initial = { tpm: { text: "10" }, prm: { text: "" } };

    expect(applyRateLimitDraftField(initial, "tpm", " 250 ")).toEqual({ tpm: { text: " 250 " }, prm: { text: "" } });
    expect(applyRateLimitDraftField(initial, "tpm", "1e3")).toEqual({
      tpm: { text: "1e3", error: "Tokens per minute must be a whole number." },
      prm: { text: "" },
    });
    expect(applyRateLimitDraftField(initial, "prm", "0")).toEqual({ tpm: { text: "10" }, prm: { text: "0" } });
    expect(applyRateLimitDraftField(initial, "tpm", "")).toEqual({ tpm: { text: "" }, prm: { text: "" } });
  });

  it("sets and deletes numeric fields without touching other members", () => {
    const model = { id: "demo", name: "Demo", tpm: 5 };

    expect(setModelRateLimitField(model, "tpm", 250)).toEqual({ id: "demo", name: "Demo", tpm: 250 });
    expect(setModelRateLimitField(model, "tpm", undefined)).toEqual({ id: "demo", name: "Demo" });
    expect(setModelRateLimitField(model, "prm", 0)).toEqual({ id: "demo", name: "Demo", tpm: 5, prm: 0 });
  });

  it("reconciles rename and add without orphaning drafts", () => {
    const previous = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "b", prm: 2 }] } } };
    const drafts = modelRateLimitDraftsFromDocument(previous);
    const bKey = rateLimitDraftKey("acme", "b", 0);
    const bDraft = drafts[bKey];
    if (bDraft === undefined) throw new Error("Expected draft for b");
    drafts[bKey] = applyRateLimitDraftField(bDraft, "prm", "bad");

    const renamedDocument = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "renamed", prm: 2 }] } } };
    const afterRename = reconcileRateLimitDrafts(drafts, previous, renamedDocument, { type: "rename", providerName: "acme", from: "b", to: "renamed" });

    expect(afterRename[rateLimitDraftKey("acme", "renamed", 0)]?.prm.error).toBeDefined();
    expect(afterRename[bKey]).toBeUndefined();

    const addedDocument = { providers: { acme: { models: [{ id: "a", tpm: 1 }, { id: "renamed", prm: 2 }, { id: "new" }] } } };
    const afterAdd = reconcileRateLimitDrafts(afterRename, renamedDocument, addedDocument);

    expect(afterAdd[rateLimitDraftKey("acme", "new", 0)]).toEqual({ tpm: { text: "" }, prm: { text: "" } });
    expect(afterAdd[rateLimitDraftKey("acme", "a", 0)]).toEqual({ tpm: { text: "1" }, prm: { text: "" } });
  });

  it("shifts drafts for later occurrences of a deleted duplicate", () => {
    const previous = { providers: { acme: { models: [{ id: "demo", tpm: 1 }, { id: "demo", tpm: 2 }] } } };
    const drafts = modelRateLimitDraftsFromDocument(previous);
    drafts[rateLimitDraftKey("acme", "demo", 1)] = { tpm: { text: "bad", error: "Tokens per minute must be a whole number." }, prm: { text: "" } };
    const next = { providers: { acme: { models: [{ id: "demo", tpm: 2 }] } } };

    const afterDelete = reconcileRateLimitDrafts(drafts, previous, next, { type: "delete", providerName: "acme", modelId: "demo", occurrence: 0 });

    expect(afterDelete[rateLimitDraftKey("acme", "demo", 0)]?.tpm.error).toBe("Tokens per minute must be a whole number.");
    expect(afterDelete[rateLimitDraftKey("acme", "demo", 1)]).toBeUndefined();
  });

  it("returns the first invalid draft with its identity", () => {
    const drafts = modelRateLimitDraftsFromDocument({
      providers: { acme: { models: [{ id: "demo", tpm: "bad" }, { id: "second", prm: "worse" }] } },
    });

    expect(firstInvalidRateLimitDraft(drafts)).toMatchObject({
      key: rateLimitDraftKey("acme", "demo", 0),
      providerName: "acme",
      modelId: "demo",
      field: "tpm",
      message: "Tokens per minute must be a whole number.",
    });
    expect(firstInvalidRateLimitDraft({})).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/models/modelsConfigDraft.test.ts`
Expected: FAIL, the new helpers are not exported.

- [ ] **Step 3: Add the helpers to `src/client/src/components/models/modelsConfigDraft.ts`**

Extend the imports:

```ts
import {
  MODEL_RATE_LIMIT_FIELDS,
  modelRateLimitFieldMessage,
  parseModelRateLimitDraftText,
  parseModelRateLimitStoredValue,
  type ModelRateLimitField,
} from "../../../../shared/modelRateLimits";
```

Append the new types and functions to the same file:

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
  prm: ModelRateLimitFieldDraft;
}

export type ModelRateLimitDraftMap = Record<string, ModelRateLimitDraft>;

export type RateLimitDraftReconciliationChange =
  | { type: "rename"; providerName: string; from: string; to: string }
  | { type: "delete"; providerName: string; modelId: string; occurrence: number };

/** Unambiguous identity key for one models[] occurrence. */
export function rateLimitDraftKey(providerName: string, modelId: string, occurrence: number): string {
  return JSON.stringify(["model-rate-limit-draft", providerName, modelId, occurrence]);
}

export function modelRateLimitDraftsFromDocument(document: ModelsConfigDocument): ModelRateLimitDraftMap {
  const drafts: ModelRateLimitDraftMap = {};
  for (const [providerName, provider] of Object.entries(document.providers ?? {})) {
    const occurrences = new Map<string, number>();
    for (const model of provider.models ?? []) {
      const occurrence = occurrences.get(model.id) ?? 0;
      occurrences.set(model.id, occurrence + 1);
      drafts[rateLimitDraftKey(providerName, model.id, occurrence)] = modelRateLimitDraftFromEntry(model);
    }
  }
  return drafts;
}

export function applyRateLimitDraftField(
  draft: ModelRateLimitDraft,
  field: ModelRateLimitField,
  text: string,
): ModelRateLimitDraft {
  const parsed = parseModelRateLimitDraftText(text);
  const nextField: ModelRateLimitFieldDraft = parsed.ok
    ? { text }
    : { text, error: modelRateLimitFieldMessage(field, parsed.reason) };
  return { ...draft, [field]: nextField };
}

export function setModelRateLimitField(
  model: ModelsConfigModel,
  field: ModelRateLimitField,
  value: number | undefined,
): ModelsConfigModel {
  const next = { ...model };
  if (value === undefined) {
    delete next[field];
  } else {
    next[field] = value;
  }
  return next;
}

export function reconcileRateLimitDrafts(
  drafts: ModelRateLimitDraftMap,
  previousDocument: ModelsConfigDocument,
  nextDocument: ModelsConfigDocument,
  change?: RateLimitDraftReconciliationChange,
): ModelRateLimitDraftMap {
  const carried = change === undefined ? { ...drafts } : draftsAfterChange(drafts, previousDocument, change);
  const nextDrafts = modelRateLimitDraftsFromDocument(nextDocument);
  const result: ModelRateLimitDraftMap = {};
  for (const [key, nextDraft] of Object.entries(nextDrafts)) {
    result[key] = carried[key] ?? nextDraft;
  }
  return result;
}

export function firstInvalidRateLimitDraft(
  drafts: ModelRateLimitDraftMap,
): { key: string; providerName: string; modelId: string; field: ModelRateLimitField; message: string } | undefined {
  for (const [key, draft] of Object.entries(drafts)) {
    for (const field of MODEL_RATE_LIMIT_FIELDS) {
      const error = draft[field].error;
      if (error === undefined) continue;
      const identity = rateLimitDraftKeyIdentity(key);
      return { key, providerName: identity.providerName, modelId: identity.modelId, field, message: error };
    }
  }
  return undefined;
}

function modelRateLimitDraftFromEntry(entry: ModelsConfigModel): ModelRateLimitDraft {
  const draft: ModelRateLimitDraft = { tpm: { text: "" }, prm: { text: "" } };
  for (const field of MODEL_RATE_LIMIT_FIELDS) {
    const parsed = parseModelRateLimitStoredValue(entry[field]);
    if (!parsed.ok) {
      draft[field] = { text: "", loadedInvalidValue: entry[field], error: modelRateLimitFieldMessage(field, parsed.reason) };
    } else if (parsed.value !== undefined) {
      draft[field] = { text: String(parsed.value) };
    }
  }
  return draft;
}

function draftsAfterChange(
  drafts: ModelRateLimitDraftMap,
  previousDocument: ModelsConfigDocument,
  change: RateLimitDraftReconciliationChange,
): ModelRateLimitDraftMap {
  const next = { ...drafts };
  if (change.type === "rename") {
    const count = occurrenceCount(previousDocument, change.providerName, change.from);
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      const fromKey = rateLimitDraftKey(change.providerName, change.from, occurrence);
      const draft = next[fromKey];
      if (draft === undefined) continue;
      next[rateLimitDraftKey(change.providerName, change.to, occurrence)] = draft;
      delete next[fromKey];
    }
    return next;
  }

  const count = occurrenceCount(previousDocument, change.providerName, change.modelId);
  delete next[rateLimitDraftKey(change.providerName, change.modelId, change.occurrence)];
  for (let occurrence = change.occurrence; occurrence < count - 1; occurrence += 1) {
    const fromKey = rateLimitDraftKey(change.providerName, change.modelId, occurrence + 1);
    const draft = next[fromKey];
    if (draft === undefined) continue;
    next[rateLimitDraftKey(change.providerName, change.modelId, occurrence)] = draft;
    delete next[fromKey];
  }
  return next;
}

function occurrenceCount(document: ModelsConfigDocument, providerName: string, modelId: string): number {
  const models = document.providers?.[providerName]?.models ?? [];
  return models.filter((model) => model.id === modelId).length;
}

function rateLimitDraftKeyIdentity(key: string): { providerName: string; modelId: string } {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed)) return { providerName: "", modelId: "" };
  return {
    providerName: typeof parsed[1] === "string" ? parsed[1] : "",
    modelId: typeof parsed[2] === "string" ? parsed[2] : "",
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/models/modelsConfigDraft.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/models/modelsConfigDraft.ts src/client/src/components/models/modelsConfigDraft.test.ts
git commit -m "feat(client): add rate limit draft identity and reconciliation helpers"
```

## Task 14: Dialog Rate limits section

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/ModelsConfigDialog.ts:1-870`
- Modify: `src/client/src/components/ModelsConfigDialog.test.ts:1-60`
- Test: `src/client/src/components/ModelsConfigDialog.rateLimits.test.ts`
- Test: `src/client/src/components/PiWebUiApp.modelsConfig.test.ts` (existing dialog wiring must stay green; no source change)

**Interfaces:**

- Consumes: all Task 13 draft helpers and types; `HttpRequestError`, `ModelsConfigRequestError`, `ModelsConfigLimitsStatusResponse` from Task 12; `parseModelRateLimitDraftText`, `type ModelRateLimitField` from Task 1; `modelsConfigApi` from Task 12.
- Produces: dialog behavior only (no new exports). The optional dependency is `limitsStatus?: (machineId?: string) => Promise<ModelsConfigLimitsStatusResponse>` on the dialog's `modelsApi` type, so existing four-function stubs keep compiling.

- [ ] **Step 1: Write the failing test**

```ts
/** @vitest-environment jsdom */
import { HttpRequestError, type Machine, type ModelsConfigDocument } from "../api";
import { ModelsConfigRequestError } from "../api/modelsConfigError";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsConfigDialog } from "./ModelsConfigDialog";

const DOCUMENT: ModelsConfigDocument = {
  providers: {
    acme: {
      api: "openai-completions",
      models: [{ id: "demo", tpm: 100, prm: 60 }, { id: "other" }],
    },
  },
};

function machine(id: string): Machine {
  return {
    id,
    name: "Remote build host",
    kind: "remote",
    baseUrl: "https://remote.example.test/",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

interface MountOptions {
  document?: ModelsConfigDocument;
  documentError?: unknown;
  limitsStatus?: unknown;
  limitsError?: unknown;
  saveError?: unknown;
}

async function mountDialog(options: MountOptions = {}) {
  const dialog = new ModelsConfigDialog();
  const modelsApi = {
    config: vi.fn(() => options.documentError !== undefined ? Promise.reject(options.documentError) : Promise.resolve(options.document ?? DOCUMENT)),
    limitsStatus: vi.fn(() => options.limitsError !== undefined
      ? Promise.reject(options.limitsError)
      : Promise.resolve(options.limitsStatus ?? { contractVersion: 1, revision: 1, admission: "ready", source: "accepted-document" })),
    save: vi.fn(() => options.saveError !== undefined ? Promise.reject(options.saveError) : Promise.resolve({ success: true, contractVersion: 1, revision: 2 })),
    test: vi.fn().mockResolvedValue({ ok: true, latencyMs: 4 }),
    discover: vi.fn().mockResolvedValue({ models: [] }),
  };
  dialog.machine = machine("remote-a");
  dialog.modelsApi = modelsApi;
  document.body.append(dialog);
  await dialog.updateComplete;
  await vi.waitFor(() => { expect(dialog.shadowRoot?.querySelector(".provider-row")).not.toBeNull(); });
  return { dialog, modelsApi };
}

function shadow(dialog: ModelsConfigDialog): ShadowRoot {
  const root = dialog.shadowRoot;
  if (root === null) throw new Error("Expected shadow root");
  return root;
}

async function selectModel(dialog: ModelsConfigDialog, index: number): Promise<void> {
  const row = shadow(dialog).querySelectorAll<HTMLButtonElement>(".model-row")[index];
  if (row === undefined) throw new Error(`Missing model row ${String(index)}`);
  row.click();
  await dialog.updateComplete;
}

async function inputText(dialog: ModelsConfigDialog, id: string, value: string): Promise<void> {
  const input = shadow(dialog).querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) throw new Error(`Missing input #${id}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await dialog.updateComplete;
}

function saveButton(dialog: ModelsConfigDialog): HTMLButtonElement {
  const button = shadow(dialog).querySelector<HTMLButtonElement>("button.primary");
  if (button === null) throw new Error("Missing Save button");
  return button;
}

async function clickSave(dialog: ModelsConfigDialog): Promise<void> {
  saveButton(dialog).click();
  await dialog.updateComplete;
}

function footerText(dialog: ModelsConfigDialog): string {
  return shadow(dialog).querySelector("footer")?.textContent ?? "";
}

describe("ModelsConfigDialog rate limits", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the unframed Rate limits section between context and cost with Unlimited placeholders", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);

    const section = shadow(dialog).querySelector("section.rate-limits-section");
    expect(section).not.toBeNull();
    expect(section?.querySelector(".section-label")?.textContent).toBe("Rate limits");
    expect(shadow(dialog).querySelector("#model-tpm")?.getAttribute("placeholder")).toBe("Unlimited");
    expect(shadow(dialog).querySelector("#model-prm")?.getAttribute("placeholder")).toBe("Unlimited");
    const costSection = shadow(dialog).querySelector("section.cost-section");
    expect(section !== null && costSection !== null && (section.compareDocumentPosition(costSection) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  it("applies valid set and clear edits to the saved payload", async () => {
    const { dialog, modelsApi } = await mountDialog();
    await selectModel(dialog, 0);

    await inputText(dialog, "model-tpm", "250");
    await inputText(dialog, "model-prm", "");
    await clickSave(dialog);
    await vi.waitFor(() => { expect(modelsApi.save).toHaveBeenCalledTimes(1); });

    const [saved] = modelsApi.save.mock.calls[0] ?? [];
    expect(saved).toEqual({ providers: { acme: { api: "openai-completions", models: [{ id: "demo", tpm: 250 }, { id: "other" }] } } });
    expect(footerText(dialog)).toContain("Saved and reloaded models");
  });

  it("blocks Save and shows the field error for invalid input", async () => {
    const { dialog, modelsApi } = await mountDialog();
    await selectModel(dialog, 0);

    await inputText(dialog, "model-tpm", "1e3");

    expect(saveButton(dialog).disabled).toBe(true);
    expect(shadow(dialog).querySelector("#model-tpm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
      .toBe("Tokens per minute must be a whole number.");
    expect(modelsApi.save).not.toHaveBeenCalled();
  });

  it("blocks Save after navigating away from an invalid model and names the identity", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);
    await inputText(dialog, "model-tpm", "1.5");
    await selectModel(dialog, 1);

    expect(saveButton(dialog).disabled).toBe(true);
    expect(footerText(dialog)).toContain("Fix rate limits for acme/demo before saving.");
  });

  it("blocks Save for a loaded invalid stored value", async () => {
    const { dialog } = await mountDialog({
      document: { providers: { acme: { models: [{ id: "demo", tpm: "bad" }] } } },
    });
    await selectModel(dialog, 0);

    expect(saveButton(dialog).disabled).toBe(true);
    expect(shadow(dialog).querySelector("#model-tpm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
      .toBe("Tokens per minute must be a whole number.");
  });

  it("disables Save and clears the tree when the document load fails", async () => {
    const { dialog } = await mountDialog({ documentError: new Error("parse failed") });

    await vi.waitFor(() => { expect(saveButton(dialog).disabled).toBe(true); });
    expect(shadow(dialog).querySelectorAll(".provider-row")).toHaveLength(0);
    expect(footerText(dialog)).toContain("Failed to load models configuration");
  });

  it("shows the blocked and last-known-good status banners", async () => {
    const blocked = await mountDialog({ limitsStatus: { contractVersion: 1, revision: 1, admission: "blocked", source: "none", error: "bad file" } });
    await vi.waitFor(() => { expect(footerText(blocked.dialog)).toContain("Model requests are blocked: bad file"); });

    const lastGood = await mountDialog({ limitsStatus: { contractVersion: 1, revision: 1, admission: "ready", source: "last-known-good", error: "parse failed" } });
    await vi.waitFor(() => { expect(footerText(lastGood.dialog)).toContain("Active limits come from the last accepted configuration: parse failed"); });
  });

  it("tolerates a 404 limits sidecar and keeps editing available", async () => {
    const { dialog, modelsApi } = await mountDialog({ limitsError: new HttpRequestError("Not Found", 404) });

    expect(footerText(dialog)).not.toContain("Failed to load rate-limit status");
    await selectModel(dialog, 0);
    expect(saveButton(dialog).disabled).toBe(false);
    expect(modelsApi.config).toHaveBeenCalled();
  });

  it("maps a structured INVALID_LIMITS save failure onto the offending field", async () => {
    const failure = new ModelsConfigRequestError("Requests per minute must be a whole number.", 400, {
      code: "MODELS_CONFIG_INVALID_LIMITS",
      file: "models.json",
      provider: "acme",
      modelId: "demo",
      field: "prm",
      occurrence: 0,
      reason: "not-a-number",
    });
    const { dialog } = await mountDialog({ saveError: failure });
    await selectModel(dialog, 0);

    await clickSave(dialog);
    await vi.waitFor(() => {
      expect(shadow(dialog).querySelector("#model-prm")?.closest(".field-stack")?.querySelector(".field-error")?.textContent)
        .toBe("Requests per minute must be a whole number.");
    });
    expect(saveButton(dialog).disabled).toBe(true);
  });

  it("keeps Test usable while a rate-limit draft is invalid and drops stale draft state on machine change", async () => {
    const { dialog } = await mountDialog();
    await selectModel(dialog, 0);
    await inputText(dialog, "model-tpm", "1e3");

    const testButton = [...shadow(dialog).querySelectorAll<HTMLButtonElement>("button.secondary")]
      .find((button) => button.textContent?.includes("Test"));
    expect(testButton?.disabled).toBe(false);

    dialog.machine = machine("remote-b");
    await dialog.updateComplete;
    await vi.waitFor(() => { expect(shadow(dialog).querySelector(".provider-row")).not.toBeNull(); });
    await selectModel(dialog, 0);

    expect(shadow(dialog).querySelector<HTMLInputElement>("#model-tpm")?.value).toBe("100");
    expect(saveButton(dialog).disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/ModelsConfigDialog.rateLimits.test.ts`
Expected: FAIL: the section, drafts, gating, and status handling do not exist.

- [ ] **Step 3: Modify `src/client/src/components/ModelsConfigDialog.ts`**

Imports. Replace the `../api` import with one that includes `HttpRequestError`, `modelsConfigApi`, `ModelsConfigRequestError`, and `type ModelsConfigLimitsStatusResponse`; add imports from `../../../shared/modelRateLimits` and from `./models/modelsConfigDraft`:

```ts
import { modelRateLimitFieldMessage, parseModelRateLimitDraftText, type ModelRateLimitField } from "../../../shared/modelRateLimits";
import {
  THINKING_LEVELS,
  addCustomProvider,
  addModel,
  applyRateLimitDraftField,
  firstInvalidRateLimitDraft,
  modelApiOptionStates,
  modelIdOptionStates,
  modelRateLimitDraftsFromDocument,
  rateLimitDraftKey,
  reconcileRateLimitDrafts,
  removeModel,
  removeProvider,
  renameProvider,
  setModelRateLimitField,
  setThinkingLevelMapEntry,
  updateModel,
  updateProvider,
  type ModelRateLimitDraft,
  type ModelRateLimitDraftMap,
  type RateLimitDraftReconciliationChange,
  type ThinkingLevel,
} from "./models/modelsConfigDraft";
```

Change the dependency type:

```ts
type ModelsConfigApi = Pick<typeof modelsConfigApi, "config" | "save" | "test" | "discover"> & {
  limitsStatus?: (machineId?: string) => Promise<ModelsConfigLimitsStatusResponse>;
};
```

Add state next to `discoveredModels`:

```ts
  @state() private loadFailed = false;
  @state() private rateLimitDrafts: ModelRateLimitDraftMap = {};
  @state() private rateLimitsStatus: ModelsConfigLimitsStatusResponse | undefined;
  @state() private rateLimitsStatusError = "";
```

In `render()`, render a load-failed state in place of the detail pane and render the notice + gated Save in the footer:

```ts
              ${this.loading ? html`<div class="empty-state">Loading model configuration...</div>` : this.loadFailed ? this.renderLoadFailed() : this.renderDetail()}
```

```ts
            <div class="footer-message" aria-live="polite">
              ${this.error !== "" ? html`<span class="error-message">${this.error}</span>` : null}
              ${this.savedMessage !== "" ? html`<span class="saved-message">${this.savedMessage}</span>` : null}
              ${this.renderRateLimitsNotice()}
            </div>
```

```ts
            <button type="button" class="primary" ?disabled=${this.saving || this.loading || this.loadFailed || this.rateLimitSaveBlock() !== ""} @click=${() => { void this.saveConfig(); }}>
              ${this.saving ? "Saving..." : "Save"}
            </button>
```

Also add `?disabled=${this.loadFailed}` to the `Add provider` button so editing is disabled after a failed load.

Insert the section in `renderModelDetail` immediately before `<section class="cost-section">`:

```ts
        <section class="rate-limits-section">
          <span class="section-label">Rate limits</span>
          <div class="field-grid two-columns">
            ${this.renderRateLimitField("tpm", "Tokens per minute (TPM)", providerName, index, model)}
            ${this.renderRateLimitField("prm", "Requests per minute (PRM)", providerName, index, model)}
          </div>
        </section>
```

Replace `loadConfig`, `saveConfig`, `replaceModel`, `addModel`, `deleteModel`, `addCustomProvider`, `deleteProvider`, `renameSelectedProvider`, and `resetForMachineChange` with the versions below, and add the new private helpers:

```ts
  private async loadConfig(): Promise<void> {
    const requestSequence = ++this.loadRequestSequence;
    const machineId = this.machineId();
    this.modelDiscoveryRequestSequences.clear();
    this.discoveredModels = {};
    this.loading = true;
    this.error = "";
    this.savedMessage = "";
    this.loadFailed = false;
    this.rateLimitsStatus = undefined;
    this.rateLimitsStatusError = "";

    const statusRequest = this.modelsApi.limitsStatus?.(machineId);
    const statusResult = statusRequest === undefined
      ? undefined
      : statusRequest.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

    try {
      const config = normalizeConfig(await this.modelsApi.config(machineId));
      if (!this.isCurrentLoad(requestSequence, machineId)) return;
      this.config = config;
      this.rateLimitDrafts = modelRateLimitDraftsFromDocument(config);
      this.selection = validSelection(this.selection, config);
      this.providerNameDraft = this.selection?.type === "provider" ? this.selection.providerName : "";
      this.renameError = "";
      this.advancedErrors = {};
      this.modelTests = {};
    } catch (error) {
      if (this.isCurrentLoad(requestSequence, machineId)) {
        this.loadFailed = true;
        this.config = { providers: {} };
        this.selection = undefined;
        this.providerNameDraft = "";
        this.rateLimitDrafts = {};
        this.modelTests = {};
        this.discoveredModels = {};
        this.error = `Failed to load models configuration: ${errorMessage(error)}`;
      }
    } finally {
      if (this.isCurrentLoad(requestSequence, machineId)) this.loading = false;
    }

    if (statusResult !== undefined) await this.applyLimitsStatus(requestSequence, machineId, statusResult);
  }

  private async applyLimitsStatus(
    requestSequence: number,
    machineId: string,
    result: Promise<{ ok: true; value: ModelsConfigLimitsStatusResponse } | { ok: false; error: unknown }>,
  ): Promise<void> {
    const settled = await result;
    if (!this.isCurrentLoad(requestSequence, machineId)) return;
    if (settled.ok) {
      this.rateLimitsStatus = settled.value;
      this.rateLimitsStatusError = "";
      return;
    }
    this.rateLimitsStatus = undefined;
    this.rateLimitsStatusError = settled.error instanceof HttpRequestError && settled.error.status === 404
      ? ""
      : `Failed to load rate-limit status: ${errorMessage(settled.error)}`;
  }

  private async saveConfig(): Promise<void> {
    if (this.saving || this.loading || this.loadFailed) return;
    if (this.rateLimitSaveBlock() !== "") {
      this.error = this.rateLimitSaveBlock();
      return;
    }
    const machineId = this.machineId();
    this.saving = true;
    this.error = "";
    this.savedMessage = "";
    try {
      const response = await this.modelsApi.save(this.config, machineId);
      if (machineId !== this.machineId()) return;
      this.rateLimitDrafts = modelRateLimitDraftsFromDocument(this.config);
      this.rateLimitsStatus = {
        contractVersion: 1,
        revision: response.revision ?? 0,
        admission: "ready",
        source: "accepted-document",
      };
      this.rateLimitsStatusError = "";
      this.setSavedMessage(`Saved and reloaded models for ${this.machineLabel()}.`);
      this.onSaved?.();
    } catch (error) {
      if (machineId === this.machineId()) this.applySaveFailure(error);
    } finally {
      if (machineId === this.machineId()) this.saving = false;
    }
  }

  private applySaveFailure(error: unknown): void {
    if (error instanceof ModelsConfigRequestError) {
      const { code, provider, modelId, field, occurrence } = error.details;
      if (code === "MODELS_CONFIG_INVALID_LIMITS" && field !== undefined) {
        const key = rateLimitDraftKey(provider ?? "", modelId ?? "", occurrence ?? 0);
        const current = this.rateLimitDrafts[key];
        if (current !== undefined) {
          this.rateLimitDrafts = {
            ...this.rateLimitDrafts,
            [key]: { ...current, [field]: { ...current[field], error: error.message } },
          };
        }
      }
      if (code === "MODELS_CONFIG_REFRESH_FAILED") {
        this.error = `Saved, but the active model configuration could not be reloaded: ${error.message}`;
        return;
      }
      if (code === "MODELS_CONFIG_UNREADABLE") {
        this.error = `${error.message} Fix models.json externally, then Reload before saving.`;
        return;
      }
    }
    this.error = `Failed to save models configuration: ${errorMessage(error)}`;
  }

  private rateLimitSaveBlock(): string {
    const invalid = firstInvalidRateLimitDraft(this.rateLimitDrafts);
    return invalid === undefined ? "" : `Fix rate limits for ${invalid.providerName}/${invalid.modelId} before saving.`;
  }

  private rateLimitsNotice(): string {
    const status = this.rateLimitsStatus;
    if (status === undefined) return this.rateLimitsStatusError;
    if (status.admission === "blocked") return `Model requests are blocked: ${status.error ?? ""}`;
    if (status.source === "last-known-good" && status.error !== undefined) {
      return `Active limits come from the last accepted configuration: ${status.error}`;
    }
    return this.rateLimitsStatusError;
  }

  private renderRateLimitsNotice(): TemplateResult | null {
    const notice = this.rateLimitsNotice();
    return notice === "" ? null : html`<span class="rate-limits-notice">${notice}</span>`;
  }

  private renderLoadFailed(): TemplateResult {
    return html`<div class="empty-state"><strong>Model configuration could not be loaded.</strong><span>Fix the file on the selected machine, then use Reload.</span></div>`;
  }

  private renderRateLimitField(field: ModelRateLimitField, label: string, providerName: string, index: number, model: ModelsConfigModel): TemplateResult {
    const id = field === "tpm" ? "model-tpm" : "model-prm";
    const draft = this.rateLimitDraftFor(providerName, index, model);
    const error = draft[field].error;
    return html`
      <div class="field-stack">
        <label for=${id}>${label}</label>
        <input id=${id} type="number" min="0" step="1" inputmode="numeric" placeholder="Unlimited" .value=${draft[field].text} @input=${(event: Event) => { this.applyRateLimitInput(providerName, index, model, field, textValue(event)); }}>
        ${error === undefined ? null : html`<span class="field-error">${error}</span>`}
      </div>
    `;
  }

  private rateLimitDraftFor(providerName: string, index: number, model: ModelsConfigModel): ModelRateLimitDraft {
    const occurrence = this.occurrenceOf(providerName, index, model.id);
    return this.rateLimitDrafts[rateLimitDraftKey(providerName, model.id, occurrence)] ?? { tpm: { text: "" }, prm: { text: "" } };
  }

  private applyRateLimitInput(providerName: string, index: number, model: ModelsConfigModel, field: ModelRateLimitField, text: string): void {
    const occurrence = this.occurrenceOf(providerName, index, model.id);
    const key = rateLimitDraftKey(providerName, model.id, occurrence);
    const current = this.rateLimitDrafts[key] ?? { tpm: { text: "" }, prm: { text: "" } };
    this.rateLimitDrafts = { ...this.rateLimitDrafts, [key]: applyRateLimitDraftField(current, field, text) };
    const parsed = parseModelRateLimitDraftText(text);
    if (!parsed.ok) return;
    this.replaceModel(providerName, index, setModelRateLimitField(model, field, parsed.value));
  }

  private occurrenceOf(providerName: string, index: number, modelId: string): number {
    const models = this.config.providers?.[providerName]?.models ?? [];
    let occurrence = 0;
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (models[candidate]?.id === modelId) occurrence += 1;
    }
    return occurrence;
  }

  private reconcileDrafts(previousDocument: ModelsConfigDocument, change?: RateLimitDraftReconciliationChange): void {
    this.rateLimitDrafts = reconcileRateLimitDrafts(this.rateLimitDrafts, previousDocument, this.config, change);
  }
```

Mutation methods become:

```ts
  private addCustomProvider(): void {
    const previousDocument = this.config;
    const added = addCustomProvider(this.config);
    this.config = added.config;
    this.reconcileDrafts(previousDocument);
    this.selectProvider(added.providerName);
  }

  private deleteProvider(providerName: string): void {
    const previousDocument = this.config;
    this.clearProviderDiscovery(providerName);
    this.config = removeProvider(this.config, providerName);
    this.reconcileDrafts(previousDocument);
    this.modelTests = clearProviderTests(this.modelTests, providerName);
    const nextProvider = Object.keys(this.config.providers ?? {})[0];
    if (nextProvider === undefined) {
      this.selection = undefined;
      this.providerNameDraft = "";
    } else {
      this.selectProvider(nextProvider);
    }
  }

  private renameSelectedProvider(providerName: string): void {
    const previousDocument = this.config;
    const renamed = renameProvider(this.config, providerName, this.providerNameDraft);
    if ("error" in renamed) {
      this.renameError = renamed.error;
      return;
    }
    const newName = this.providerNameDraft.trim();
    this.clearProviderDiscovery(providerName);
    this.config = renamed.config;
    this.reconcileDrafts(previousDocument);
    this.modelTests = renameProviderTests(this.modelTests, providerName, newName);
    this.selectProvider(newName);
  }

  private addModel(providerName: string): void {
    const count = this.config.providers?.[providerName]?.models?.length ?? 0;
    const previousDocument = this.config;
    this.config = addModel(this.config, providerName);
    this.reconcileDrafts(previousDocument);
    this.selectModel(providerName, count);
  }

  private deleteModel(providerName: string, index: number): void {
    const deleted = this.config.providers?.[providerName]?.models?.[index];
    const previousDocument = this.config;
    const occurrence = deleted === undefined ? 0 : this.occurrenceOf(providerName, index, deleted.id);
    this.config = removeModel(this.config, providerName, index);
    if (deleted !== undefined) {
      this.reconcileDrafts(previousDocument, { type: "delete", providerName, modelId: deleted.id, occurrence });
    }
    this.modelTests = clearProviderTests(this.modelTests, providerName);
    this.selectProvider(providerName);
  }

  private replaceModel(providerName: string, index: number, model: ModelsConfigModel): void {
    const previousModel = this.config.providers?.[providerName]?.models?.[index];
    const previousDocument = this.config;
    this.config = updateModel(this.config, providerName, index, model);
    if (previousModel !== undefined && previousModel.id !== model.id) {
      this.reconcileDrafts(previousDocument, { type: "rename", providerName, from: previousModel.id, to: model.id });
    }
    const key = modelTestKey(providerName, index);
    if (this.modelTests[key] !== undefined) this.modelTests = recordWithoutKey(this.modelTests, key);
  }
```

`resetForMachineChange` adds:

```ts
    this.loadFailed = false;
    this.rateLimitDrafts = {};
    this.rateLimitsStatus = undefined;
    this.rateLimitsStatusError = "";
```

Add to the component styles:

```css
    .rate-limits-section { display: grid; gap: 10px; }
    .rate-limits-notice { color: var(--pi-muted); }
```

- [ ] **Step 4: Update `src/client/src/components/ModelsConfigDialog.test.ts`**

Add one test proving the optional sidecar dependency is used without breaking four-function stubs:

```ts
  it("loads the selected machine's limits status when the API provides it", async () => {
    const config: ModelsConfigDocument = { providers: { custom: { api: "openai-completions" } } };
    const limitsStatus = vi.fn().mockResolvedValue({ contractVersion: 1, revision: 1, admission: "ready", source: "accepted-document" });
    const modelsApi = {
      config: vi.fn().mockResolvedValue(config),
      limitsStatus,
      save: vi.fn().mockResolvedValue({ success: true }),
      test: vi.fn(),
      discover: vi.fn(),
    };
    const dialog = new ModelsConfigDialog();
    dialog.machine = machine("remote-a");
    dialog.modelsApi = modelsApi;

    await callDialogPromise(dialog, "loadConfig");
    await vi.waitFor(() => { expect(limitsStatus).toHaveBeenCalledWith("remote-a"); });
  });
```

- [ ] **Step 5: Run the dialog tests**

Run: `npm test -- --run src/client/src/components/ModelsConfigDialog.test.ts src/client/src/components/ModelsConfigDialog.rateLimits.test.ts src/client/src/components/PiWebUiApp.modelsConfig.test.ts`
Expected: PASS in all three files.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/client/src/components/ModelsConfigDialog.ts src/client/src/components/ModelsConfigDialog.test.ts src/client/src/components/ModelsConfigDialog.rateLimits.test.ts
git commit -m "feat(client): edit per-model rate limits in the Models dialog"
```

## Task 15: Browser geometry verification

**Implementer tier:** Capable

**Files:**

- Create (temporary, deleted before commit): `src/client/rate-limits-probe.html`
- Create (temporary, deleted before commit): `src/client/rate-limits-probe.ts`
- Create (temporary, deleted before commit): `rate-limits-probe-cdp.mjs`

**Interfaces:**

- Consumes: the real `ModelsConfigDialog` element and the Task 14 `rate-limits-section` markup; the documented `probe-narrow-lit-layout-with-chromium-cdp` procedure (`/home/henry/.pi/agent/projects-memory/pi-webui/skills/probe-narrow-lit-layout-with-chromium-cdp/SKILL.md`).
- Produces: recorded measurement JSON and screenshots in the implementation handoff; no committed file.

- [ ] **Step 1: Create the temporary Vite fixture**

`src/client/rate-limits-probe.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Rate limits probe</title>
  </head>
  <body>
    <pre id="result">pending</pre>
    <script type="module" src="/rate-limits-probe.ts"></script>
  </body>
</html>
```

`src/client/rate-limits-probe.ts`:

```ts
import type { Machine, ModelsConfigDocument } from "./src/api";
import { ModelsConfigDialog } from "./src/components/ModelsConfigDialog";

const machine: Machine = {
  id: "local",
  name: "Local machine",
  kind: "local",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const documentFixture: ModelsConfigDocument = {
  providers: {
    acme: {
      api: "openai-completions",
      models: [{ id: "model-large", tpm: 100_000, prm: 60 }],
    },
  },
};

const dialog = new ModelsConfigDialog();
dialog.machine = machine;
dialog.modelsApi = {
  config: () => Promise.resolve(documentFixture),
  limitsStatus: () => Promise.resolve({ contractVersion: 1 as const, revision: 1, admission: "ready" as const, source: "accepted-document" as const }),
  save: () => Promise.resolve({ success: true as const, contractVersion: 1 as const, revision: 2 }),
  test: () => Promise.resolve({ ok: true }),
  discover: () => Promise.resolve({ models: [] }),
};
document.body.append(dialog);

function rectangle(element: Element | null): Record<string, number> | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
}

function overflow(element: Element | null): { clientWidth: number; scrollWidth: number } | null {
  return element === null ? null : { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
}

async function measure(): Promise<void> {
  await dialog.updateComplete;
  await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(undefined); }); }); });
  const root = dialog.shadowRoot;
  if (root === null) throw new Error("Expected shadow root");
  const section = root.querySelector(".rate-limits-section");
  const contextGrid = section?.previousElementSibling ?? null;
  const costSection = root.querySelector(".cost-section");
  const tpm = root.querySelector("#model-tpm");
  const prm = root.querySelector("#model-prm");
  const dialogElement = root.querySelector(".dialog");
  const result = {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentOverflow: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    dialog: rectangle(dialogElement),
    dialogOverflow: overflow(dialogElement),
    contextGrid: rectangle(contextGrid),
    rateLimitsSection: rectangle(section),
    costSection: rectangle(costSection),
    tpm: rectangle(tpm),
    prm: rectangle(prm),
    labelOverflow: overflow(section?.querySelector(".section-label") ?? null),
    tpmLabelOverflow: overflow(tpm?.closest(".field-stack")?.querySelector("label") ?? null),
    prmLabelOverflow: overflow(prm?.closest(".field-stack")?.querySelector("label") ?? null),
    fieldErrorOverflow: overflow(root.querySelector(".field-error")),
  };
  const output = document.getElementById("result");
  if (output !== null) output.textContent = JSON.stringify(result);
}

await dialog.updateComplete;
await new Promise((resolve) => { setTimeout(resolve, 50); });
const modelRow = dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".model-row")[0];
if (modelRow === undefined) throw new Error("Expected a selectable model");
modelRow.click();
await measure();
```

- [ ] **Step 2: Create the temporary CDP probe script**

`rate-limits-probe-cdp.mjs` (run with `node rate-limits-probe-cdp.mjs`; it exits non-zero on any failed assertion):

```js
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTENT_PORT = 5199;
const DEBUG_PORT = 9339;
const CHROMIUM = process.env["CHROMIUM_BIN"] ?? "chromium";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
  { name: "boundary-700", width: 700, height: 844, mobile: true },
  { name: "above-701", width: 701, height: 844, mobile: false },
];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitForHttp(url, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const profile = await mkdtemp(join(tmpdir(), "pi-webui-rate-limits-cdp-"));
const vite = spawn("npm", ["run", "dev:client", "--", "--port", String(CONTENT_PORT), "--strictPort"], { stdio: "inherit" });
const browser = spawn(CHROMIUM, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "about:blank",
], { stdio: "ignore" });

const failures = [];
const measurements = {};

try {
  await waitForHttp(`http://127.0.0.1:${CONTENT_PORT}/rate-limits-probe.html`);
  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json());
  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (handler !== undefined) { pending.delete(message.id); handler(message); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");

  for (const viewport of VIEWPORTS) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${CONTENT_PORT}/rate-limits-probe.html` });
    let measurement;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const evaluated = await send("Runtime.evaluate", { expression: "document.getElementById('result')?.textContent ?? ''", returnByValue: true });
      const text = evaluated.result?.result?.value;
      if (typeof text === "string" && text.startsWith("{")) { measurement = JSON.parse(text); break; }
      await sleep(100);
    }
    if (measurement === undefined) throw new Error(`No measurement for ${viewport.name}`);
    measurements[viewport.name] = measurement;

    const near = (a, b) => Math.abs(a - b) <= 1;
    const fail = (message) => { failures.push(`${viewport.name}: ${message}`); };
    if (measurement.viewport.width !== viewport.width) fail(`innerWidth ${measurement.viewport.width} != ${viewport.width}`);
    if (measurement.documentOverflow.scrollWidth > measurement.documentOverflow.clientWidth) fail("document scrolls horizontally");
    if (measurement.dialogOverflow.scrollWidth > measurement.dialogOverflow.clientWidth) fail("dialog scrolls horizontally");
    if (measurement.rateLimitsSection.top < measurement.contextGrid.bottom - 1) fail("rate limits section overlaps context row");
    if (measurement.rateLimitsSection.bottom > measurement.costSection.top + 1) fail("rate limits section overlaps cost section");
    if (viewport.width > 700) {
      if (!(measurement.tpm.right <= measurement.prm.left + 1)) fail("TPM and PRM are not side by side");
      if (!(measurement.tpm.top < measurement.prm.bottom && measurement.prm.top < measurement.tpm.bottom)) fail("two-column rows do not overlap vertically");
    } else if (!(measurement.prm.top >= measurement.tpm.bottom - 1)) {
      fail("PRM is not below TPM in one column");
    }
    if (measurement.tpm.left < measurement.dialog.left - 1 || measurement.prm.right > measurement.dialog.right + 1) fail("inputs escape the dialog edges");
    for (const [name, overflow] of Object.entries({
      label: measurement.labelOverflow,
      tpmLabel: measurement.tpmLabelOverflow,
      prmLabel: measurement.prmLabelOverflow,
      fieldError: measurement.fieldErrorOverflow,
    })) {
      if (overflow !== null && overflow.scrollWidth > overflow.clientWidth) fail(`${name} clips its text`);
    }

    await send("Runtime.evaluate", { expression: "document.querySelector('models-config-dialog').shadowRoot.querySelector('#model-tpm').focus()" });
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const focusedAfterOne = await send("Runtime.evaluate", { expression: "document.querySelector('models-config-dialog').shadowRoot.activeElement?.id ?? ''", returnByValue: true });
    if (focusedAfterOne.result?.result?.value !== "model-prm") fail("Tab from TPM does not reach PRM");
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const focusedAfterTwo = await send("Runtime.evaluate", { expression: "document.querySelector('models-config-dialog').shadowRoot.activeElement?.id ?? ''", returnByValue: true });
    if (!String(focusedAfterTwo.result?.result?.value ?? "").startsWith("cost-")) fail("Tab from PRM does not reach the first cost input");
  }

  console.log(JSON.stringify(measurements, null, 2));
  if (failures.length > 0) { console.error(failures.join("\n")); process.exitCode = 1; }
} finally {
  browser.kill("SIGKILL");
  vite.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
}
```

- [ ] **Step 3: Run the probe at all four viewports**

Run: `node rate-limits-probe-cdp.mjs`
Expected: exit code 0, printed measurement JSON for `desktop`, `mobile`, `boundary-700`, and `above-701`, and no assertion lines on stderr. If Chromium is not on `PATH`, set `CHROMIUM_BIN` to the installed binary first.

- [ ] **Step 4: Record the evidence and remove every temporary artifact**

Copy the printed measurement JSON and capture desktop/mobile screenshots into the implementation handoff report. Then delete `src/client/rate-limits-probe.html`, `src/client/rate-limits-probe.ts`, and `rate-limits-probe-cdp.mjs`, stop any leftover Vite or Chromium process, and verify:

Run: `git status --short`
Expected: no `rate-limits-probe` path appears; only the Task 14 source/test changes are present (or nothing new, since Task 14 committed).

- [ ] **Step 5: Commit only if the probe required a real production fix**

If the probe failed and you fixed `ModelsConfigDialog` styles or markup, commit that fix together with the Task 14 dialog files:

```bash
git add src/client/src/components/ModelsConfigDialog.ts
git commit -m "fix(client): keep rate limit fields inside the dialog at narrow widths"
```

If the probe passed with no production change, there is nothing to commit; record the measurement JSON in the handoff instead.

## Task 16: Documentation and release note

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:256-261`
- Modify: `docs/config.html:683-704`
- Create: `.changeset/per-model-tpm-prm-controls.md`

**Interfaces:**

- Consumes: nothing from other tasks at compile time; the behavior described in Tasks 1-15.
- Produces: user-facing documentation and a `minor` Changeset for the published package.

- [ ] **Step 1: Add the documentation section to `docs/config.md`**

Insert immediately after the paragraph that ends `This is Pi profile state, not a PI WEBUI config-file key.` in the `### Models and skills` section, and before `### Utility models`:

```md
### Per-model rate limits

Custom providers can carry optional **TPM** (tokens per minute) and **PRM** (requests per minute) limits per model. In **Models → Model configuration**, select a model and edit **Rate limits** between its Context window / Max output tokens fields and Cost. Leave a field blank for `Unlimited`, or set `0` to disable that dimension explicitly. The existing **Save** action persists the values into `models.json` for the selected machine's active profile and activates accepted limits without a daemon restart.

- **TPM** counts the model call's reported terminal usage: `input + output + cacheRead + cacheWrite`. `totalTokens` is not added again, and `maxTokens`, prompt size, and streaming deltas are never reserved or counted.
- The window is rolling 60 seconds, not aligned calendar minutes: an entry stops counting exactly 60 seconds after it was recorded, and a call is admitted only while the retained request count is below PRM and the retained token sum is below TPM.
- Calls to one provider plus model ID share one budget across every session, spawned session, compaction, branch summary, session name, utility fallback, speech polishing, and connection test in that daemon. Different model IDs, and the same model ID under different provider names, are independent.
- When a limit is exhausted, later calls to that model wait in first-in, first-out order. Waiting never spends a PRM unit. Cancelling a waiting call removes it before dispatch; an already-dispatched call keeps its unit and reports its usage.
- Reported usage can exceed TPM for one call: actual usage is not a hard ceiling. Already-dispatched calls finish, and later calls wait until recorded usage ages out.
- Limits are local to the daemon and its active agent profile. Separate machines, separate daemons, standalone Pi CLI runs, and other applications do not share them.
- Installing this feature requires one manual `pi-webui-sessiond.service` restart. Editing `models.json` outside PI WEBUI requires a daemon restart before the new limits are guaranteed to load; saving through the dialog activates accepted limits immediately.
- If `models.json` cannot be parsed, the dialog reports the failure and refuses to overwrite the file. If a limit value is invalid, the document stays editable so you can repair it in place. A daemon with no accepted configuration reports `Model requests are blocked: ...` in the dialog and fails model calls closed until a valid document is saved.
```

- [ ] **Step 2: Mirror the section in `docs/config.html`**

Insert immediately after the closing `</section>` of the `Models and skills` section and before `<section id="utility-models">`:

```html
            <section id="per-model-rate-limits">
              <h2>Per-model rate limits</h2>
              <p>
                Custom providers can carry optional <strong>TPM</strong> (tokens per minute) and <strong>PRM</strong>
                (requests per minute) limits per model. In <strong>Models → Model configuration</strong>, select a model and
                edit <strong>Rate limits</strong> between its Context window / Max output tokens fields and Cost. Leave a
                field blank for <code>Unlimited</code>, or set <code>0</code> to disable that dimension explicitly. The
                existing <strong>Save</strong> action persists the values into <code>models.json</code> for the selected
                machine's active profile and activates accepted limits without a daemon restart.
              </p>
              <ul>
                <li><strong>TPM</strong> counts the model call's reported terminal usage: <code>input + output + cacheRead + cacheWrite</code>. <code>totalTokens</code> is not added again, and <code>maxTokens</code>, prompt size, and streaming deltas are never reserved or counted.</li>
                <li>The window is rolling 60 seconds, not aligned calendar minutes: an entry stops counting exactly 60 seconds after it was recorded, and a call is admitted only while the retained request count is below PRM and the retained token sum is below TPM.</li>
                <li>Calls to one provider plus model ID share one budget across every session, spawned session, compaction, branch summary, session name, utility fallback, speech polishing, and connection test in that daemon. Different model IDs, and the same model ID under different provider names, are independent.</li>
                <li>When a limit is exhausted, later calls to that model wait in first-in, first-out order. Waiting never spends a PRM unit. Cancelling a waiting call removes it before dispatch; an already-dispatched call keeps its unit and reports its usage.</li>
                <li>Reported usage can exceed TPM for one call: actual usage is not a hard ceiling. Already-dispatched calls finish, and later calls wait until recorded usage ages out.</li>
                <li>Limits are local to the daemon and its active agent profile. Separate machines, separate daemons, standalone Pi CLI runs, and other applications do not share them.</li>
                <li>Installing this feature requires one manual <code>pi-webui-sessiond.service</code> restart. Editing <code>models.json</code> outside PI WEBUI requires a daemon restart before the new limits are guaranteed to load; saving through the dialog activates accepted limits immediately.</li>
                <li>If <code>models.json</code> cannot be parsed, the dialog reports the failure and refuses to overwrite the file. If a limit value is invalid, the document stays editable so you can repair it in place. A daemon with no accepted configuration reports <code>Model requests are blocked: ...</code> in the dialog and fails model calls closed until a valid document is saved.</li>
              </ul>
            </section>
```

- [ ] **Step 3: Create the Changeset**

`.changeset/per-model-tpm-prm-controls.md`:

```md
---
"@hyperdreamer/pi-webui": minor
---

Add optional per-model TPM and PRM rate limits. Set them per model in **Models → Model configuration → Rate limits**; PI WEBUI queues calls in FIFO order over a rolling 60-second window and charges actual reported terminal tokens. Installing this change requires one manual `pi-webui-sessiond.service` restart.
```

Do not edit `CHANGELOG.md` and do not change `README.md`.

- [ ] **Step 4: Verify the docs and release note**

Run: `git diff --check`
Expected: no whitespace errors.

Run: `node -e "const t=require('node:fs').readFileSync('.changeset/per-model-tpm-prm-controls.md','utf8'); if(!t.includes('\"@hyperdreamer/pi-webui\": minor')) process.exit(1); if(!t.includes('pi-webui-sessiond.service')) process.exit(1); console.log('changeset ok')"`
Expected: `changeset ok`.

Run: `node -e "const fs=require('node:fs'); for (const file of ['docs/config.md','docs/config.html']) { const t=fs.readFileSync(file,'utf8'); for (const needle of ['Rate limits','rolling 60 seconds','pi-webui-sessiond.service','Unlimited']) { if(!t.includes(needle)) { console.error(file+' missing '+needle); process.exit(1); } } } console.log('docs ok')"`
Expected: `docs ok`.

- [ ] **Step 5: Commit**

```bash
git add docs/config.md docs/config.html .changeset/per-model-tpm-prm-controls.md
git commit -m "docs(models): document per-model TPM and PRM controls"
```


