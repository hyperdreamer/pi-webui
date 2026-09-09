# Unbounded Transcript Polishing & Polishing Reasoning Suppression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow unbounded transcript polishing completions without token truncation on reasoning models while suppressing thinking tokens and preserving size/timeout bounds.

**Architecture:** Remove the fixed 512-token cap (`SPEECH_INPUT_POLISHING_MAX_TOKENS`) from `speechInputPolishingService.ts` to allow unconstrained completion bounded by model context window, wall-clock timeout (25s), and post-completion byte limits (1 MiB). Suppress internal reasoning by evaluating `clampThinkingLevel(candidate.model, "off")` and omitting the `reasoning` option field when `"off"` (or passing the model's minimum supported level if reasoning is mandatory).

**Tech Stack:** TypeScript, Node.js, Vitest, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, Changesets.

## Global Constraints

- Node 22.19 is the version floor; do not use APIs newer than that.
- No new runtime dependencies.
- Omit the `reasoning` field completely from `ModelsSimpleStreamOptions` when resolved level is `"off"`; never pass `{ reasoning: undefined }` or `{ reasoning: "off" }`.
- Omit `maxTokens` completely from `ModelsSimpleStreamOptions`; `Object.prototype.hasOwnProperty.call(options, "maxTokens")` must be false.
- Do not modify `src/client/src/components/settings/SettingsGeneralPanel.ts` because the UI disclosure already matches 1 MiB text bounds and does not mention token caps.
- Changes to `speechInputPolishingService.ts` execute inside `src/server/sessiond.ts`, which runs under systemd service `pi-webui-sessiond.service`.
- Every task's requirements implicitly include this section.

## Task 1: Unbounded completion & reasoning clamping unit tests (Red Phase)

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/speechInput/speechInputPolishingService.test.ts:40-100`

**Interfaces:**

- Consumes: `createSpeechInputPolishingService`, `SpeechInputPolishingUnavailableError`, `SpeechInputPolishingAbortedError` from `src/server/speechInput/speechInputPolishingService.ts`.
- Consumes: `fakeModel`, `candidate`, `assistantMessage`, `createHarness` test helpers in `src/server/speechInput/speechInputPolishingService.test.ts`.
- Produces: Updated unit test suite in `src/server/speechInput/speechInputPolishingService.test.ts` with assertions for `maxTokens` omission, thinking level clamping with property omission, mandatory reasoning handling, per-candidate clamping during fallback, and 1 MiB boundary validation.

- [ ] **Step 1: Write failing unit tests**

Edit `src/server/speechInput/speechInputPolishingService.test.ts` to:
1. Update `fakeModel` helper to accept an optional `thinkingLevels?: ThinkingLevel[]` argument. When provided, assign `thinkingLevels` or supported levels to the mock model.
2. Update the existing test `"passes the fixed context, candidate thinking level, signal, and bounded one-shot options"` to expect `maxTokens` not to be present on `received?.options` instead of expecting a positive number.
3. Add a dedicated test `"omits maxTokens from completeSimple options"`.
4. Add a test `"omits reasoning property when model supports off"`.
5. Add a test `"passes lowest clamped thinking level when model mandates reasoning"`.
6. Add a test `"evaluates clamping per candidate independently during fallback"`.
7. Add a test `"accepts output at exact 1 MiB boundary and rejects output exceeding 1 MiB"`.

Code to integrate:
```ts
  it("omits maxTokens from completeSimple options", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const service = createHarness([candidate(firstModel)], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect(capturedOptions).toBeDefined();
    expect("maxTokens" in (capturedOptions ?? {})).toBe(false);
    expect(capturedOptions?.maxTokens).toBeUndefined();
  });

  it("omits reasoning property when model supports off", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const modelWithOptionalReasoning = fakeModel("acme", "reasoning-optional", ["off", "low", "high"]);
    const service = createHarness([candidate(modelWithOptionalReasoning, "high")], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect("reasoning" in (capturedOptions ?? {})).toBe(false);
  });

  it("passes lowest clamped thinking level when model mandates reasoning", async () => {
    let capturedOptions: ModelsSimpleStreamOptions | undefined;
    const modelRequiringReasoning = fakeModel("acme", "reasoning-required", ["minimal", "low", "high"]);
    const service = createHarness([candidate(modelRequiringReasoning, "high")], (_model, _context, options) => {
      capturedOptions = options;
      return Promise.resolve(assistantMessage([{ type: "text", text: "polished text" }]));
    });

    await expect(service.polish(rawTranscript)).resolves.toBe("polished text");
    expect(capturedOptions?.reasoning).toBe("minimal");
  });

  it("evaluates clamping per candidate independently during fallback", async () => {
    const optionsSeen: (ModelsSimpleStreamOptions | undefined)[] = [];
    const candidate1 = candidate(fakeModel("acme", "model-1", ["off", "high"]), "high");
    const candidate2 = candidate(fakeModel("acme", "model-2", ["minimal", "high"]), "high");

    const service = createHarness([candidate1, candidate2], (model, _context, options) => {
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

  it("accepts output at exact 1 MiB boundary and rejects output exceeding 1 MiB", async () => {
    const exactLimitText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES);
    const serviceExact = createHarness([candidate(firstModel)], () =>
      Promise.resolve(assistantMessage([{ type: "text", text: exactLimitText }])),
    );
    await expect(serviceExact.polish(rawTranscript)).resolves.toBe(exactLimitText);

    const oversizedText = "a".repeat(SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES + 1);
    const serviceOversized = createHarness([candidate(firstModel)], () =>
      Promise.resolve(assistantMessage([{ type: "text", text: oversizedText }])),
    );
    await expect(serviceOversized.polish(rawTranscript)).rejects.toBeInstanceOf(
      SpeechInputPolishingUnavailableError,
    );
  });
```

And update `fakeModel`:
```ts
function fakeModel(
  provider: string,
  id: string,
  thinkingLevels?: ThinkingLevel[],
): Model<Api> {
  const model: Model<Api> = {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
  if (thinkingLevels !== undefined) {
    (model as { thinkingLevels?: ThinkingLevel[] }).thinkingLevels = thinkingLevels;
  }
  return model;
}
```

- [ ] **Step 2: Run tests and confirm test failures (Red phase)**

Run: `npm run test:fast -- src/server/speechInput/speechInputPolishingService.test.ts`
Expected: FAIL on the new assertions (`maxTokens` is still present, `reasoning` is not clamped to `"off"` or omitted).

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/server/speechInput/speechInputPolishingService.test.ts
git commit -m "test(speechInput): add tests for unbounded transcript polishing and reasoning suppression"
```

## Task 2: Implement unbounded polishing and reasoning suppression (Green Phase)

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/speechInput/speechInputPolishingService.ts:1-120`

**Interfaces:**

- Consumes: `clampThinkingLevel` from `@earendil-works/pi-ai`.
- Consumes: `ResolvedUtilityModel`, `UtilityModelResolver` from `../sessions/utilityModelResolver.js`.
- Produces: `SpeechInputPolishingService` in `src/server/speechInput/speechInputPolishingService.ts` with `SPEECH_INPUT_POLISHING_MAX_TOKENS` removed, `maxTokens` omitted from stream options, and reasoning dynamically clamped per candidate via `clampThinkingLevel(candidate.model, "off")`.

- [ ] **Step 1: Update implementation in `speechInputPolishingService.ts`**

1. Import `clampThinkingLevel` from `@earendil-works/pi-ai`:
   ```ts
   import {
     clampThinkingLevel,
     type Api,
     type AssistantMessage,
     type Context,
     type Model,
     type ModelsSimpleStreamOptions,
   } from "@earendil-works/pi-ai";
   ```
2. Remove `export const SPEECH_INPUT_POLISHING_MAX_TOKENS = 512;`.
3. In `SpeechInputPolishingService.polish`, inside the `for (const candidate of lightweightCandidates)` loop, resolve the clamped thinking level:
   ```ts
   const polishingThinkingLevel = clampThinkingLevel(candidate.model, "off");
   ```
4. Build `options` omitting `maxTokens` and omitting `reasoning` when `polishingThinkingLevel === "off"`:
   ```ts
   const options: ModelsSimpleStreamOptions = {
     ...(polishingThinkingLevel === "off" ? {} : { reasoning: polishingThinkingLevel }),
     maxRetries: 0,
     cacheRetention: "none",
     timeoutMs: SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS,
     ...(signal === undefined ? {} : { signal }),
   };
   ```

- [ ] **Step 2: Run unit tests and confirm they pass (Green phase)**

Run: `npm run test:fast -- src/server/speechInput/speechInputPolishingService.test.ts`
Expected: PASS, all tests in `speechInputPolishingService.test.ts` pass.

- [ ] **Step 3: Run full speech input test suite and typecheck**

Run: `npm run test:fast -- src/server/speechInput/`
Expected: PASS.
Run: `npm run test:fast -- src/client/src/controllers/speechInputController.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/server/speechInput/speechInputPolishingService.ts
git commit -m "fix(speechInput): remove 512-token polishing cap and suppress model reasoning"
```

## Task 3: Changeset, verification, and session daemon restart instructions

**Implementer tier:** Fast

**Files:**

- Create: `.changeset/fix-voice-transcript-polishing-token-limit.md`

**Interfaces:**

- Consumes: Working `speechInputPolishingService.ts` and test suite from Task 2.
- Produces: Patch changeset file `.changeset/fix-voice-transcript-polishing-token-limit.md`.

- [ ] **Step 1: Create the changeset file**

Write `.changeset/fix-voice-transcript-polishing-token-limit.md` with:
```markdown
---
"@hyperdreamer/pi-webui": patch
---

Fix voice input transcript polishing failures with thinking models by removing the 512-token cap and suppressing reasoning during polishing.
```

- [ ] **Step 2: Validate changeset status**

Run: `npx changeset status`
Expected: PASS, showing 1 patch change for `@hyperdreamer/pi-webui`.

- [ ] **Step 3: Run comprehensive verification**

Run: `npm run verify:fast`
Expected: PASS.

- [ ] **Step 4: Commit changeset**

```bash
git add .changeset/fix-voice-transcript-polishing-token-limit.md
git commit -m "chore(changeset): add patch changeset for transcript polishing token limit fix"
```

- [ ] **Step 5: Document required service restart**

Per `AGENTS.md`, `speechInputPolishingService.ts` runs in the daemon process (`sessiond.ts`) managed by `pi-webui-sessiond.service`. Note in the completion handoff that applying these changes in the local environment requires restarting the session daemon:
```bash
systemctl --user restart pi-webui-sessiond.service
```
