# Technical Specification: Unbounded Transcript Polishing & Polishing Reasoning Suppression

**Date:** 2026-09-09  
**Status:** Approved  
**Related Design Document:** `docs/superpowers/specs/2026-09-09-unbounded-transcript-polishing-design.md`  
**Target Package:** `@hyperdreamer/pi-webui`  

---

## 1. Overview & Context

When speech input transcript polishing is enabled in PI WEBUI, audio transcripts captured by Browser or Cloud providers are sent to the local gateway session daemon to be conservatively polished by the configured `lightweight` utility model before insertion into the prompt editor.

In the current implementation (`src/server/speechInput/speechInputPolishingService.ts`), completions specify `maxTokens: SPEECH_INPUT_POLISHING_MAX_TOKENS = 512`. When the configured `lightweight` model is a reasoning model (or has reasoning enabled), the underlying provider caps the sum of reasoning/thinking tokens plus text tokens at 512 tokens. Models such as `gemini-flash-high` generate ~500 tokens of internal reasoning even on concise inputs, exhausting the token budget before producing full output. The provider then returns `stopReason: "length"`, which `extractPolishedText` rejects as incomplete (`message.stopReason !== "stop"`), failing with `SpeechInputPolishingUnavailableError`. The browser client then falls back to inserting the raw transcript with the warning:
> *"Voice input polishing failed; inserted the raw transcript."*

This specification defines the exact technical implementation to:
1. Eliminate the restrictive `maxTokens: 512` constraint, allowing unconstrained model completion up to `model.maxTokens` while preserving post-completion size boundaries (`SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES = 1 MiB`) and wall-clock timeouts (`SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`).
2. Suppress internal reasoning for transcript polishing by evaluating `clampThinkingLevel(candidate.model, "off")` and omitting the `reasoning` option field when `"off"`, or falling back to the model's lowest supported thinking level (e.g. `"minimal"`) when reasoning cannot be turned off.

---

## 2. Precise Data Structures & Type Definitions

### 2.1 Polishing Constants (`src/server/speechInput/speechInputPolishingService.ts`)

```typescript
// REMOVED:
// export const SPEECH_INPUT_POLISHING_MAX_TOKENS = 512;

// RETAINED:
export const SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES = SPEECH_INPUT_MAX_TRANSCRIPT_BYTES; // 1,048,576 bytes (1 MiB)
export const SPEECH_INPUT_POLISHING_SYSTEM_PROMPT =
  "Return only polished plain text. Preserve meaning, intent, technical tokens, and explicit requirements. Correct capitalization, punctuation, spacing, and unambiguous disfluencies only. Do not add, delete, or infer requirements. Do not include explanations, markdown, quotation wrappers, labels, or commentary.";
```

### 2.2 Model Runtime Stream Options (`@earendil-works/pi-ai`)

`completeSimple` in `ModelRuntime` takes:
```typescript
export interface ModelsSimpleStreamOptions {
  reasoning?: ThinkingLevel;
  maxTokens?: number;
  maxRetries?: number;
  cacheRetention?: "none" | "short" | "long";
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

### 2.3 Resolved Candidate Data Structure (`src/server/sessions/utilityModelResolver.ts`)

```typescript
export interface ResolvedUtilityModel<TModel extends UtilityModelIdentity> {
  model: TModel;
  thinkingLevel: ThinkingLevel;
  slot: UtilityModelSlot; // "lightweight"
}
```

---

## 3. Reasoning Clamping & Option Omission Rules

### 3.1 Clamping Logic (`clampThinkingLevel`)

Import `clampThinkingLevel` directly from `@earendil-works/pi-ai`:
```typescript
import { clampThinkingLevel } from "@earendil-works/pi-ai";
```

For each candidate in `lightweightCandidates`, the effective polishing thinking level is resolved against the candidate's specific model schema:
```typescript
const polishingThinkingLevel = clampThinkingLevel(candidate.model, "off");
```

Upstream `@earendil-works/pi-ai` implementation semantics:
- Retrieves `getSupportedThinkingLevels(model)`.
- If `"off"` is in `availableLevels`, returns `"off"`.
- If `"off"` is not supported, climbs the ordered hierarchy `["off", "minimal", "low", "medium", "high", "xhigh", "max"]` to find the nearest supported level (typically `"minimal"`).
- If no matches in the forward loop, searches downward, falling back to `availableLevels[0] ?? "off"`.

### 3.2 Property Omission Semantics

When `polishingThinkingLevel === "off"`, the `reasoning` field must be completely omitted from `ModelsSimpleStreamOptions`. It must **not** be passed as `{ reasoning: undefined }` or `{ reasoning: "off" }`.
- `@earendil-works/pi-ai` treats the absence of the `reasoning` property as disabling thinking tokens for providers that support optional reasoning.
- When `polishingThinkingLevel !== "off"` (i.e. reasoning cannot be turned off on that model), pass `{ reasoning: polishingThinkingLevel }`.

Exact construction in `speechInputPolishingService.ts`:
```typescript
const options: ModelsSimpleStreamOptions = {
  ...(polishingThinkingLevel === "off" ? {} : { reasoning: polishingThinkingLevel }),
  maxRetries: 0,
  cacheRetention: "none",
  timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS,
  ...(signal === undefined ? {} : { signal }),
};
```

### 3.3 Complete Removal of `maxTokens`

- No `maxTokens` property is defined on `options`.
- `Object.prototype.hasOwnProperty.call(options, "maxTokens")` must evaluate to `false`.
- When `maxTokens` is omitted, `@earendil-works/pi-ai` defaults token allocation to `model.maxTokens` (bounded by model context window), ensuring adequate room for any required reasoning tokens plus complete text generation.

---

## 4. Bounding, Safety & Error Contracts

### 4.1 Resource Bounding Strategy
Removing `maxTokens` shifts safety enforcement to two explicit boundaries:
1. **Wall-Clock Timeout:**
   - Provider model timeout: `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000` (25 seconds).
   - HTTP route and client deadline: `SPEECH_INPUT_POLISHING_ROUTE_TIMEOUT_MS = 30_000` (30 seconds).
   - This ensures requests cannot hang or consume indefinite daemon compute.
2. **Post-Completion Size Validation:**
   - Enforced in `extractPolishedText(message: AssistantMessage): string | undefined`.
   - UTF-8 byte length is validated:
     ```typescript
     if (Buffer.byteLength(text, "utf8") > SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES) {
       return undefined;
     }
     ```
   - If output exceeds 1 MiB (1,048,576 bytes), `extractPolishedText` returns `undefined`, triggering candidate fallback or `SpeechInputPolishingUnavailableError`.
3. **Generation Memory / Buffer:**
   - `completeSimple` buffers stream chunks in memory up to `model.maxTokens`. For text polishing, the prompt is bounded to 1 MiB input, and the model prompt explicitly instructs conservative plain text output. The buffered memory footprint is bounded and ephemeral.

### 4.2 Error Contracts & Non-Leaking Boundary
- `SpeechInputPolishingUnavailableError`:
  - Thrown when candidate list is empty, all candidates fail or return non-stop reasons, model outputs invalid/oversized/empty text, or `completeSimple` throws.
  - Returns HTTP 503 with generic JSON payload: `{ "error": "Speech input polishing is unavailable." }`.
  - Never echoes transcript contents, prompt tokens, credential sources, or provider stack traces.
- `SpeechInputPolishingAbortedError`:
  - Thrown when the client cancels or disconnects during the request.
  - Aborts in-flight `completeSimple` call via `AbortController`/`AbortSignal`.

---

## 5. Settings Disclosure & UI Boundary

Inspect `src/client/src/components/settings/SettingsGeneralPanel.ts`:
- Under **Transcript polishing**, the disclosure text states:
  > *"Transcript polishing accepts at most two concurrent requests. Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response. Input and polished output are each limited to 1 MiB of UTF-8 text. If polishing times out or fails, PI WEBUI inserts the original transcript instead."*
- Verification: The disclosure already references the 1 MiB UTF-8 input/output bounds and does not mention 512 tokens or token limits. No changes to `SettingsGeneralPanel.ts` are necessary, avoiding unnecessary UI churn.

---

## 6. Operational & Daemon Restart Requirements

Per `AGENTS.md` and repository guidelines:
- `SpeechInputPolishingService` is constructed in `src/server/sessiond.ts`:
  ```typescript
  const speechInputPolishing = createSpeechInputPolishingService({
    modelRuntime: auth.runtime,
    utilityModelResolver,
  });
  ```
- `src/server/sessiond.ts` runs under the long-lived `pi-webui-sessiond.service` user systemd service.
- **Operational Requirement:** Because this change modifies `src/server/speechInput/speechInputPolishingService.ts` executed exclusively by `sessiond`, running this in production or local environments requires restarting the session daemon:
  ```bash
  systemctl --user restart pi-webui-sessiond.service
  ```
- UI/Vite reload (`pi-webui-ui-dev.service`) alone will not pick up the change.

---

## 7. Changeset Specification

Per `.agents/skills/changeset-changelog/SKILL.md`, a patch changeset file will be created at `.changeset/fix-voice-transcript-polishing-token-limit.md`:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Fix voice input transcript polishing failures with thinking models by removing the 512-token cap and suppressing reasoning during polishing.
```

---

## 8. Test Fixtures & Unit Test Specifications

File: `src/server/speechInput/speechInputPolishingService.test.ts`

### 8.1 Removal of `maxTokens` Assertion
```typescript
it("omits maxTokens from completeSimple options", async () => {
  let capturedOptions: ModelsSimpleStreamOptions | undefined;
  const service = createHarness([candidate(firstModel)], (model, context, options) => {
    capturedOptions = options;
    return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
  });

  await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
  expect(capturedOptions).toBeDefined();
  expect("maxTokens" in (capturedOptions ?? {})).toBe(false);
  expect(capturedOptions?.maxTokens).toBeUndefined();
});
```

### 8.2 Reasoning Suppression via `clampThinkingLevel`
```typescript
it("omits reasoning property when model supports off", async () => {
  let capturedOptions: ModelsSimpleStreamOptions | undefined;
  // Model configured with "high" thinking level, but clampThinkingLevel(model, "off") resolves to "off"
  const modelWithOptionalReasoning = fakeModel("acme", "reasoning-optional");
  const service = createHarness([candidate(modelWithOptionalReasoning, "high")], (model, context, options) => {
    capturedOptions = options;
    return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
  });

  await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
  expect("reasoning" in (capturedOptions ?? {})).toBe(false);
});

it("passes lowest clamped thinking level when model mandates reasoning", async () => {
  let capturedOptions: ModelsSimpleStreamOptions | undefined;
  // A model whose supported thinking levels exclude "off" (e.g., ["minimal", "low", "high"])
  const modelRequiringReasoning = fakeModel("acme", "reasoning-required", ["minimal", "low", "high"]);
  const service = createHarness([candidate(modelRequiringReasoning, "high")], (model, context, options) => {
    capturedOptions = options;
    return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
  });

  await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
  expect(capturedOptions?.reasoning).toBe("minimal");
});
```

### 8.3 Per-Candidate Independent Evaluation
```typescript
it("evaluates clamping per candidate independently during fallback", async () => {
  const optionsSeen: (ModelsSimpleStreamOptions | undefined)[] = [];
  const candidate1 = candidate(fakeModel("acme", "model-1", ["off", "high"]), "high");
  const candidate2 = candidate(fakeModel("acme", "model-2", ["minimal", "high"]), "high");

  const service = createHarness([candidate1, candidate2], (model, context, options) => {
    optionsSeen.push(options);
    if (model === candidate1.model) {
      return Promise.resolve(assistantMessage([], "error"));
    }
    return Promise.resolve(assistantMessage([{ type: "text", text: "polished by candidate 2" }]));
  });

  await expect(service.polish(rawTranscript)).resolves.toBe("polished by candidate 2");
  expect(optionsSeen).toHaveLength(2);
  expect("reasoning" in (optionsSeen[0] ?? {})).toBe(false);
  expect(optionsSeen[1]?.reasoning).toBe("minimal");
});
```

### 8.4 Output Boundary Validation
```typescript
it("accepts output at exact 1 MiB boundary and rejects output exceeding 1 MiB", async () => {
  const exactLimitText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES);
  const serviceExact = createHarness([candidate(firstModel)], () =>
    Promise.resolve(assistantMessage([{ type: "text", text: exactLimitText }]))
  );
  await expect(serviceExact.polish(rawTranscript)).resolves.toBe(exactLimitText);

  const oversizedText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES + 1);
  const serviceOversized = createHarness([candidate(firstModel)], () =>
    Promise.resolve(assistantMessage([{ type: "text", text: oversizedText }]))
  );
  await expect(serviceOversized.polish(rawTranscript)).rejects.toBeInstanceOf(
    SpeechInputPolishingUnavailableError
  );
});
```

---

## 9. Verification & Quality Gates

1. **Fast Unit Tests:**
   ```bash
   npm run test:fast -- src/server/speechInput/
   npm run test:fast -- src/client/src/controllers/speechInputController.test.ts
   ```
2. **Typecheck & Fast Lint Verification:**
   ```bash
   npm run typecheck
   npm run verify:fast
   ```
3. **Changeset Validation:**
   ```bash
   npx changeset status
   ```
4. **Full Workspace Verification:**
   ```bash
   npm run verify
   ```
