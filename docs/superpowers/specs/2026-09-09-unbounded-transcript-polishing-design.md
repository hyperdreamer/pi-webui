# Design Document: Unbounded Transcript Polishing & Disabling Polishing Reasoning

## 1. Background & Problem Statement
When using voice input in PI WEBUI, transcript polishing fails on almost every real sentence, falling back to the raw transcript with the warning:
> *"Voice input polishing failed; inserted the raw transcript."*

### Root Cause
1. In `src/server/speechInput/speechInputPolishingService.ts`, completions set `maxTokens: SPEECH_INPUT_POLISHING_MAX_TOKENS` where `SPEECH_INPUT_POLISHING_MAX_TOKENS = 512`.
2. When the configured `lightweight` utility model uses a reasoning model (or has reasoning enabled), the `max_tokens` API parameter caps the sum of reasoning/thinking tokens plus text tokens. Models like `gemini-flash-high` generate ~500 tokens of internal reasoning even for brief inputs.
3. Once the 512 token budget is reached during reasoning or generation, the provider returns `stopReason: "length"`.
4. `extractPolishedText` requires `message.stopReason === "stop"`. Responses with `stopReason !== "stop"` are rejected as incomplete/failed, triggering `SpeechInputPolishingUnavailableError`.
5. Additionally, the user specifically requested:
   - No `maxTokens` limit should be imposed on polishing completions.
   - Reasoning should be clamped or disabled for transcript polishing whenever possible.

## 2. Goals & Non-Goals
- **Goals**:
  - Remove the artificial `maxTokens` constraint on polishing model calls so that output text and necessary reasoning tokens are not prematurely truncated.
  - Disable or clamp reasoning to `"off"` (or the lowest supported thinking level such as `"minimal"`, or omit reasoning if disabled/unsupported) for transcript polishing, ensuring low latency and token efficiency.
  - Retain the post-completion acceptance validation of `SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES` (1 MiB UTF-8) in `extractPolishedText` and the wall-clock model timeout (`SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000`), recognizing that `completeSimple` buffers up to `model.maxTokens` before post-completion acceptance validation.
  - Update settings documentation text in `SettingsGeneralPanel.ts` if it references the old token limits or behavior.
  - Add comprehensive unit tests covering candidate-level reasoning suppression and the removal of `maxTokens`.
  - Include a patch Changeset for `@hyperdreamer/pi-webui` describing the fix.
- **Non-Goals**:
  - Changing how voice audio is transcribed or captured.
  - Changing the 30-second client-side polishing timeout or route timeout.

## 3. Architecture & Detailed Changes

### A. Polishing Service (`src/server/speechInput/speechInputPolishingService.ts`)
1. **Thinking Level Resolution for Polishing**:
   - For speech transcript polishing, the service overrides the generic utility model slot's configured thinking level by evaluating:
     ```ts
     const polishingThinkingLevel = clampThinkingLevel(candidate.model, "off");
     ```
   - If `polishingThinkingLevel === "off"`, omit the `reasoning` field entirely in `ModelsSimpleStreamOptions` (which `pi-ai` treats as disabling reasoning).
   - If the model strictly mandates reasoning and cannot be turned `"off"` (e.g. models whose thinking level map excludes `"off"`), pass `reasoning: polishingThinkingLevel` (using its clamped minimum supported level, such as `"minimal"`).
2. **Remove `maxTokens` constraint**:
   - Remove `maxTokens: SPEECH_INPUT_POLISHING_MAX_TOKENS` from the options object passed to `completeSimple`.
   - Remove the unused `SPEECH_INPUT_POLISHING_MAX_TOKENS = 512` constant.
   - Note on upstream behavior: Omitting `maxTokens` causes `pi-ai` to default to `model.maxTokens` (clamped to the context window), allowing sufficient room for both thinking tokens and text output.
   - Resource bounding & safety characteristics:
     - Waiting time is bounded by the wall-clock timeout: `SPEECH_INPUT_POLISHING_MODEL_TIMEOUT_MS = 25_000` (plus the 30s route deadline).
     - Output text payload size is bounded via post-completion acceptance validation: `SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES = 1 MiB` UTF-8 enforced in `extractPolishedText`.
     - Generation memory/tokens: Omitting the local 512-token cap allows the underlying provider to generate and buffer up to `model.maxTokens` before post-completion validation; this trade-off is accepted to avoid premature truncation on reasoning models.

### B. Settings Disclosures (`src/client/src/components/settings/SettingsGeneralPanel.ts`)
- Verify that the settings description mentions "Input and polished output are each limited to 1 MiB of UTF-8 text" and does not claim a 512-token limit. (Currently it only states "Input and polished output are each limited to 1 MiB of UTF-8 text", which remains fully accurate.)

### C. Operational & Deployment Considerations
- Per `AGENTS.md`, because `SpeechInputPolishingService` is instantiated and owned by `src/server/sessiond.ts`, deploying or running this change in a live environment requires restarting the session daemon:
  ```bash
  systemctl --user restart pi-webui-sessiond.service
  ```

### D. Release & Changeset
- Add a patch Changeset (`.changeset/fix-voice-transcript-polishing-token-limit.md`) documenting:
  - Fix voice transcript polishing failure on reasoning/thinking utility models by disabling reasoning when supported and removing the restrictive 512-token cap.

### E. Test Strategy
1. **`speechInputPolishingService.test.ts`**:
   - Verify `completeSimple` is called without `maxTokens` (asserting `maxTokens` is not an own property or key on the options object).
   - Verify a candidate configured with `"high"` whose model supports `"off"` has the `reasoning` property completely absent (not merely set to `undefined`) from the options passed to `completeSimple`.
   - Verify multiple fallback candidates evaluate clamping per candidate independently (e.g., candidate 1 has `"off"`, candidate 2 mandates `"high"`).
   - Verify a model that strictly requires reasoning (e.g. only `"high"` or `"minimal"` supported) passes the lowest clamped level.
   - Verify transcript output at the exact UTF-8 1 MiB boundary (`SPEECH_INPUT_POLISHING_MAX_OUTPUT_BYTES`) is accepted, and one byte over is rejected.
2. **Verification Suites**:
   - Focused unit tests: `npm run test:fast -- src/server/speechInput/` and `npm run test:fast -- src/client/src/controllers/speechInputController.test.ts`.
   - Workspace checks: `npm run typecheck` and `npm run verify:fast`.
   - Full serial verification before release: `npm run verify`.
