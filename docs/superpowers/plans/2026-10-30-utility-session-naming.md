# Utility Session Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking; leave the plan unchanged during execution.

**Goal:** Make automatic session names come from completed, structurally usable model titles or a cleaned six-word first-request fallback, while preserving relay precedence and naming lifecycle protection.

**Architecture:** Keep normalization, uncapped title validation, display shortening, and first-request cleanup in `sessionNameGenerator.ts`. Add an opt-in attempt normalizer to the existing utility fallback runner, then have naming alone normalize to `off` before deduplication and translate generator rejections into diagnostics and fallback advancement. Keep name application, tree-navigation deferral, prompt delivery, and the other utility consumers on their existing paths.

**Tech Stack:** TypeScript, the existing Pi AI/agent SDK types and injected `StreamFn`, Vitest with file-local event-stream fixtures, npm, and Changesets. Retain the package's Node `>=22.19.0` runtime requirement.

**Contract:** `docs/superpowers/specs/2026-10-30-utility-session-naming-spec.md` (all 619 lines); approved design: `docs/superpowers/specs/2026-10-30-utility-session-naming-design.md`. The specification controls exact strings, ordering, and signatures.

### File map and execution order

| File | Responsibility and tasks |
| --- | --- |
| `src/server/sessions/sessionNameGenerator.ts` | Existing module-private limits, pure title helpers (Tasks 1–2), completed-result generation (Task 3), scaffold-aware fallback (Task 6). Keep relay helpers and `truncateInput` unchanged. |
| `src/server/sessions/sessionNameGenerator.test.ts` | Existing `fakeModel`, `fakeAssistantMessage`, and injected stream fixtures; helper, completion, Unicode, prompt, fallback, and relay coverage (Tasks 1–3, 6–7). |
| `src/server/sessions/utilityModelResolver.ts` | Only the runner's optional sixth argument and pre-key normalization loop (Task 4). |
| `src/server/sessions/utilityModelResolver.test.ts` | Preserve omitted-seam compatibility; prove normalized deduplication and normalized exception reporting (Task 4). |
| `src/server/sessions/piSessionService.ts` | Only `maybeGenerateSessionName` orchestration at baseline lines 5208–5267 (Task 5). Read `applyGeneratedSessionName` and `flushDeferredTreeNavigationWork` at 5269–5319 but keep their bodies unchanged. |
| `src/server/sessions/piSessionService.promptQueue.test.ts` | Existing runtime/event-hub harness, title request state, diagnostics, rejected-path deduplication, empty/no-model outcomes, and lifecycle boundaries (Tasks 5 and 8). Keep the runtime-factory branch-summary `reasoning: "high"` assertion at baseline line 510 unchanged. |
| `.changeset/fix-utility-session-naming.md` | The single patch release-note fragment, created only with the implemented fix (Task 9). |

All source/test line ranges below refer to the clean planning baseline; locate the named symbols after earlier tasks shift lines. Run tasks sequentially. Task 3 deliberately replaces the generator API before its sole production caller is migrated in Task 5: use the named focused suites during Tasks 3–4, then require typecheck after Task 5. Do not add a fourth-argument compatibility overload to hide that migration. Tasks 7–8 complete and falsify acceptance coverage for behavior already introduced; do not invent a failing baseline when an acceptance assertion is already green.

The planning operation creates only this document. All test commands, production edits, commits, and the Changeset below are instructions for future implementation, not work to perform while drafting the plan.

## Global Constraints

The following project-wide requirements are copied verbatim from the specification and apply to every task.

Implementation is confined to:

- `src/server/sessions/sessionNameGenerator.ts`;
- `src/server/sessions/utilityModelResolver.ts`, adding an optional per-invocation attempt normalizer;
- `src/server/sessions/piSessionService.ts`, within naming orchestration;
- the existing generator, prompt-queue service, and resolver test files specified below;
- one patch Changeset for the implemented user-visible fix.

No new runtime dependency or public configuration surface is required.

Node 22.19 is the version floor; do not use APIs newer than that.

Only title generation stops forwarding the configured level. No configuration key, API
type, route, or UI element changes, and `context` slot behaviour is untouched. So the
approved boundary holds: thinking remains available to the lightweight consumers that
use it today, and the fix is confined to the session-name generator.

- Utility candidate resolution, configured-level eligibility checks, refresh behavior, slot ordering, and the active fallback's position remain unchanged. Only title invocations opt into pre-deduplication normalization.
- Branch summaries and compaction continue forwarding their configured utility thinking levels. Context-slot behavior is unchanged. Transcript polishing already clamps its attempts to `off`; that existing behavior is not part of this fix.
- Existing relay formatting and precedence, six-word fallback extraction, session-list first-message display, late-write protection, tree-navigation deferral, and active model/thinking state remain intact.
- The title timeout stays 10 seconds per distinct retained attempt, and input truncation stays 4,000 UTF-16 code units plus an ellipsis when needed. Deduplicating identical title requests intentionally removes redundant timeout windows.

A resolved session model remains a prerequisite for model-based naming and the first-message fallback. The canonical relay-handoff name is checked before that prerequisite and keeps precedence.

These are declaration contracts; the implementation supplies function bodies. `generateShortSessionName` has no fourth argument, default thinking level, or overload accepting a thinking level. Remove its obsolete `ThinkingLevel` import. An ordinary rejected completion returns the `ok: false` variant, never a bare `undefined` or an empty success title. A successful title is normalized, validated, and shortened.

The timeout, input limit, display limit, and fallback word-count constants remain module-private. No additional exported rejection type is necessary.

The normalizer is synchronous and returns an attempt of the same model type. It is optional per runner invocation, not a resolver setting or a new configuration key. Callers that want normalization without exception diagnostics pass `undefined` in the fifth position. Existing callers that omit it retain their current behavior.

Normalization must happen before both identity computation and storing the attempt for execution. Apply it once per raw candidate, including candidates later discarded as duplicates. Do not mutate the resolver's returned objects, the active attempt, model objects, or persisted settings. The title normalizer returns a fresh attempt such as `{ ...attempt, thinkingLevel: "off" }`.

Keep authentication, headers, provider routing, rate limiting, retries inside the injected runtime, and timeout ownership unchanged. Do not add another model request, prompt variant, retry loop, or timer inside the generator.

Do not convert thrown exceptions into the `stream-error` variant. An exception thrown by `streamFn` or stream iteration continues to reject the generator promise and is handled by the runner's existing `onFailure` path. Stream events and completed-message rejection are ordinary results; thrown failures remain exceptions.

Never revalidate the shortened result. A valid full title can shorten to a prefix that ends in a connector; shortening is solely a display operation.

Do not run the generated-title word-count, echo, or connector predicate on fallback text. A fallback can legitimately end in `the` or contain a phrase such as `we need`, because it is extracted from the user's own request. The six-word slice occurs before normalization and display shortening, as in the current implementation.

Keep `deterministicSessionName` and the relay recognition/formatting helpers unchanged. The service invokes it before resolving utility candidates or checking for a session model. The existing canonical first-line format remains `Relay "<name>" leg <number> begins now.`; unrelated mentions of a relay do not match.

Preserve the current entry guards, in their current role: return when the session already has a name, has any messages, is streaming, or is compacting. Preserve scheduling and the existing prompt lifecycle; do not introduce a second naming scheduler, retry flag, or change model-policy checks.

Keep deferred-tree-work flushing and its error containment unchanged. It re-enters the same guarded application path after navigation and discards work for a session that ceased to be current. Existing names set while generation was pending continue to win. Preserve existing message/busy/name guards against repeated first-prompt naming.

No-model and empty-fallback outcomes write no name and publish no `session.name` event. The session-list fallback display does not change. Naming continues to be an out-of-band operation and must not change the active model, active thinking level, model defaults, or prompt delivery.

Use the existing Vitest files and file-local fakes. Do not call a live provider or introduce a new harness package or test helper file. Use `createAssistantMessageEventStream` for stream fixtures. Extend the existing `fakeAssistantMessage`, `completedTitleStream`, `failedTitleStream`, `titleAssistantMessage`, `utilityResolverFor`, and deferred-stream patterns as needed.

For successful and completed-rejection fixtures, explicitly push a `done` event and end the stream. For `stream-error`, push an `error` event. For `no-completion`, emit a valid-looking `text_delta`, then end the stream with a stored assistant message via `stream.end(message)` **without** pushing a `done` event, so an implementation that trusts the stored end result or the accumulated deltas still fails the case. A stored end result alone is not completion. Construct intentionally unknown content or unusual terminal states at one documented fixture boundary if the SDK's narrower event type requires a cast; keep the rest of the fixtures strictly typed.

The case names below describe concrete `it` cases; parameterized rows may use `it.each`. Assert the complete discriminated result with `toEqual`, including rejection reasons. Do not retain old string/`undefined` expectations for the generator or the old fourth-argument thinking-level calls.

Do not replace the omitted-seam compatibility fixture with a normalized one; both contracts must remain tested.

- Changing the one-api proxy, upstream Pi, model behavior, authentication, or transport.
- Changing which configured models resolve for lightweight or context utility slots.
- Changing branch-summary, compaction, or transcript-polishing prompts, budgets, or thinking behavior.
- Adding a config key, API field, route, UI control, naming scheduler, or semantic classifier.
- Renaming existing sessions, retrying naming for an already named session, or migrating stored session names.
- Providing a first-message fallback for sessions whose naming boundary has no resolved model.
- Changing prompt-model-policy authorization or introducing a new public testing seam for the no-model case.

The preceding seven bullets are the specification's non-goals, not additional work items.

The implemented fix requires one `.changeset/*.md` fragment with a `patch` bump for `@hyperdreamer/pi-webui`.

Do not manually edit `CHANGELOG.md`, bump package versions, or publish as part of implementation.

The eventual implementation changes session-daemon-loaded code. Its handoff must tell the operator that a manual restart of `pi-webui-sessiond.service` is needed for the new naming behavior to take effect; UI/API autoreload alone does not reload that runtime code.

## Task 1: Separate uncapped normalization from title validation

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessions/sessionNameGenerator.ts:64-74` (add helpers beside `cleanSessionName`; leave its current display implementation for Task 2).
- Modify/Test: `src/server/sessions/sessionNameGenerator.test.ts:1-5` and `:106-108` (imports and new pure-helper cases).

**Interfaces:**

- Consumes: existing module-private `SESSION_NAME_MAX_LENGTH = 60`; no new dependency or model interface.
- Produces: `normalizeSessionName(value: string): string | undefined`, returning the normalized first line without a length cap.
- Produces: `isUsableSessionTitle(value: string): boolean`, checking normalized, uncapped text without calling `cleanSessionName` or shortening.
- Preserves for Task 2: `cleanSessionName(value: string): string | undefined`; it will become composition of normalization and shortening.

- [ ] **Step 1: Add the normalization and validation cases before implementation.** Import the two new helpers from `./sessionNameGenerator.js`. Add these cases inside the existing describe; the data include the exact specification normalization examples and predicate boundaries.

```ts
it.each<[string, string | undefined]>([
  ['Title: "Fix Session Naming."\nextra', "Fix Session Naming"],
  ["  Session title: 'Fix\t login   bug.'  ", "Fix login bug"],
  ["Fix login bug\nWe need a title", "Fix login bug"],
  [" \nFix login bug", undefined],
  ['Title: ""', undefined],
  ["We need a session title", "We need a session title"],
  ["x".repeat(61), "x".repeat(61)],
])("normalizes labels quotes whitespace and the first line: %s", (input, expected) => {
  expect(normalizeSessionName(input)).toBe(expected);
});

it("validates uncapped title structure", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["", false], [" \t ", false], ["Login", true],
    ["Fix flaky article bridge FTS retry test", true],
    ["Fix flaky article bridge FTS retry test failures", true],
    ["Fix flaky article bridge FTS retry test failures today", false],
    ["No quotes please", false], ["Remove punctuation wrapper", false],
    ["Create a 2-6 word title", false], ["Create a 2-6 words title", false],
    ["The user wants login fixes", false], ["We need a session title", false],
    ["Need to produce title", false], ["Need to infer title", false],
    ["Need to craft title", false], ["Fix login because we need retries", false],
    ["Fix login With,", false], ["Fix login within", true],
    ["Fix login and!", false], ["Fix login by:;!?", false],
    ["Fix login wIth", false], ["Fix login without", true],
    ["x".repeat(61), true], ["界".repeat(61), true],
    ["𠮷".repeat(61), true], ["Fix need to craft title", false],
  ];
  for (const [value, expected] of cases) {
    expect(isUsableSessionTitle(value), value).toBe(expected);
  }
  for (const connector of ["and", "or", "for", "the", "a", "an", "to", "with", "of", "in", "on", "by"]) {
    expect(isUsableSessionTitle(`Fix login ${connector}`), connector).toBe(false);
  }
});
```

- [ ] **Step 2: Run the helper suite and record RED.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: failure because the new exports do not yet exist. Existing relay and fallback cases stay in the file.

- [ ] **Step 3: Add the pure helpers with this exact behavior.** The regexes intentionally retain the existing cleanup boundaries. A connector is a complete final token after stripping only its trailing ASCII punctuation.

```ts
export function normalizeSessionName(value: string): string | undefined {
  const title = (value.split("\n", 1)[0] ?? "")
    .replace(/^\s*(title|session title)\s*:\s*/i, "")
    .replace(/^\s*["'`]+|["'`.]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? undefined : title;
}

export function isUsableSessionTitle(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 8) return false;
  if (/\b(?:no quotes|punctuation wrapper|2-6 words?|the user wants|we need|need to (?:produce|infer|craft))\b/i.test(value)) {
    return false;
  }
  const lastWord = (words.at(-1) ?? "").replace(/[.,!?;:]+$/g, "");
  return !/^(?:and|or|for|the|a|an|to|with|of|in|on|by)$/i.test(lastWord);
}
```

- [ ] **Step 4: Run the helper suite and confirm GREEN.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: all existing and new generator-file cases pass. Normalization retains all 61 characters; validation accepts one/seven/eight words and rejects all echo and connector fixtures.

- [ ] **Step 5: Commit only the task files.**

```bash
git add src/server/sessions/sessionNameGenerator.ts src/server/sessions/sessionNameGenerator.test.ts
git commit -m "refactor(sessions): separate title normalization and validation"
```

## Task 2: Add code-point-safe display shortening and compose cleanup

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessions/sessionNameGenerator.ts:64-74` (`cleanSessionName` and adjacent new display helper; preserve relay bodies at baseline 76–97).
- Modify/Test: `src/server/sessions/sessionNameGenerator.test.ts:1-5` and `:106-125` (shortening, cleanup, and existing relay controls).

**Interfaces:**

- Consumes from Task 1: `normalizeSessionName(value: string): string | undefined`; it selects the first line and preserves uncapped normalized text.
- Consumes from Task 1: `isUsableSessionTitle(value: string): boolean`; neither this helper nor `cleanSessionName` should be called by shortening.
- Produces: `shortenSessionName(value: string): string`, capped at 60 Unicode code points, preferring a whitespace boundary at index `1..60` inclusive.
- Updates: `cleanSessionName(value: string): string | undefined` to normalization followed by shortening only.
- Preserves: `deterministicSessionName(firstMessage: unknown): string | undefined` and private `relayHandoffSessionName`, `formatRelaySessionName`, `truncateRelayName`, `truncateInput` bodies.

- [ ] **Step 1: Add all display-helper cases and strengthen cleanup before implementation.** Import `shortenSessionName`; keep the three existing relay tests with their exact outputs.

```ts
it("shortens at a word boundary", () => {
  expect(shortenSessionName("Improve authentication reliability across distributed production environments"))
    .toBe("Improve authentication reliability across distributed");
});
it("preserves punctuation adjacent to the shortening cut", () => {
  expect(shortenSessionName("x".repeat(59) + "! suffix")).toBe("x".repeat(59) + "!");
});
it("preserves a full sixty-code-point prefix ending at a boundary", () => {
  const expected = "Investigate strange session naming behavior across providers";
  expect(Array.from(expected)).toHaveLength(60);
  expect(shortenSessionName(`${expected} globally`)).toBe(expected);
});
it.each(["x", "界", "𠮷"])("caps an unspaced value at sixty code points: %s", (character) => {
  const result = shortenSessionName(character.repeat(61));
  expect(result).toBe(character.repeat(60));
  expect(Array.from(result)).toHaveLength(60);
  if (character === "𠮷") expect(result).toHaveLength(120);
  expect(shortenSessionName("x".repeat(61) + " suffix")).toBe("x".repeat(60));
});
it("leaves a short display string unchanged", () => {
  expect(shortenSessionName("")).toBe("");
  expect(shortenSessionName("Fix login bug")).toBe("Fix login bug");
});
it("keeps cleanSessionName as normalization plus shortening", () => {
  expect(cleanSessionName('Title: "Fix Session Naming."\nextra')).toBe("Fix Session Naming");
  expect(cleanSessionName("We need title")).toBe("We need title");
  expect(cleanSessionName("Improve authentication reliability across distributed production environments"))
    .toBe("Improve authentication reliability across distributed");
  expect(cleanSessionName('Title: ""')).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused suite and record RED.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: missing shortening export and the current UTF-16/mid-word cleanup behavior fail the new assertions.

- [ ] **Step 3: Implement shortening and replace only the cleanup body.** A whitespace code point immediately after the first 60 code points is a valid cut; a boundary later than that cannot extend the cap. Do not add an ellipsis or strip punctuation.

```ts
export function shortenSessionName(value: string): string {
  const points = Array.from(value);
  if (points.length <= SESSION_NAME_MAX_LENGTH) return value;
  let cut = SESSION_NAME_MAX_LENGTH;
  for (let index = SESSION_NAME_MAX_LENGTH; index > 0; index -= 1) {
    if (/\s/u.test(points[index] ?? "")) {
      cut = index;
      break;
    }
  }
  return points.slice(0, cut).join("").trimEnd();
}

export function cleanSessionName(value: string): string | undefined {
  const normalized = normalizeSessionName(value);
  return normalized === undefined ? undefined : shortenSessionName(normalized);
}
```

- [ ] **Step 4: Run the focused suite and confirm GREEN.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: helper cases pass, including 60 supplementary code points / 120 UTF-16 units, and the unchanged canonical/long/noncanonical relay cases retain `Relay handoff-check leg 2`, `Relay very-long-relay-name-that-would-otherwise-push leg 42`, and `undefined` respectively.

- [ ] **Step 5: Commit only the task files.**

```bash
git add src/server/sessions/sessionNameGenerator.ts src/server/sessions/sessionNameGenerator.test.ts
git commit -m "fix(sessions): shorten titles at code-point and word boundaries"
```

## Task 3: Return discriminated results only from completed usable titles

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/sessionNameGenerator.ts:1-50` (`ThinkingLevel` import, exported result type, and `generateShortSessionName` only; retain `textFromAssistant` and `truncateInput`).
- Modify/Test: `src/server/sessions/sessionNameGenerator.test.ts:1-104` (replace old request/result tests and extend the existing completion-stream pattern).
- Read: `src/server/sessions/piSessionService.ts:5230-5260` (the sole production caller is migrated in Task 5; do not create an overload).

**Interfaces:**

- Consumes from Task 1: `normalizeSessionName(value: string): string | undefined` and `isUsableSessionTitle(value: string): boolean`.
- Consumes from Task 2: `shortenSessionName(value: string): string`.
- Consumes existing `StreamFn` from `@earendil-works/pi-agent-core`, `Api`, `Model<TApi>`, `AssistantMessage`, and `normalizeContext` from `@earendil-works/pi-ai`.
- Produces the exact exported `SessionNameGeneration` union shown in Step 3, and `generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<SessionNameGeneration>`. It accepts exactly three arguments and has no default thinking level.
- Produces a file-local test fixture for Task 7: `completedMessageStream(message: AssistantMessage, doneReason?: Extract<AssistantMessageEvent, { type: "done" }>["reason"], delta?: string): StreamFn`. It pushes `done` and ends the stream; a supplied delta is deliberately independent of final text.
- Preserves file-local `fakeModel(): Model<Api>`, `fakeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage`, `streamThatCompletes(text: string): StreamFn`, and `streamThatErrors(): StreamFn` for later generator tests.

- [ ] **Step 1: Replace the obsolete fourth-argument/minimal/omitted-off tests and add completed-result contract probes.** Add `AssistantMessageEvent` to the type imports; introduce the local completion fixture and delegate `streamThatCompletes` to it. Do not alter error-event construction or keep old string/undefined generator assertions.

```ts
function completedMessageStream(
  message: AssistantMessage,
  doneReason: Extract<AssistantMessageEvent, { type: "done" }>["reason"] = "stop",
  delta?: string,
): StreamFn {
  return () => {
    const stream = createAssistantMessageEventStream();
    if (delta !== undefined) {
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
    }
    stream.push({ type: "done", reason: doneReason, message });
    stream.end(message);
    return stream;
  };
}
function streamThatCompletes(text: string): StreamFn {
  return completedMessageStream(fakeAssistantMessage({ content: [{ type: "text", text }] }));
}

it("generates a normalized title with reasoning off and a 256-token ceiling", async () => {
  const model = fakeModel();
  const streamFn = vi.fn<StreamFn>(streamThatCompletes('Title: "Fix the bug"'));
  await expect(generateShortSessionName(streamFn, model, "Please fix the login bug"))
    .resolves.toEqual({ ok: true, title: "Fix the bug" });
  expect(streamFn).toHaveBeenCalledOnce();
  expect(streamFn.mock.calls[0]?.[0]).toBe(model);
  expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "off", maxTokens: 256 });
});
it("rejects a length-limited completion", async () => {
  const streamFn = completedMessageStream(fakeAssistantMessage({
    stopReason: "length", content: [{ type: "text", text: "Fix login bug" }],
  }), "length");
  await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
});
it("rejects a stream that ends without done despite text deltas", async () => {
  const message = fakeAssistantMessage({ content: [{ type: "text", text: "Fix login bug" }] });
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Fix login bug", partial: message });
    stream.end(message);
    return stream;
  };
  await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "no-completion" });
});
it("classifies an emitted stream error directly", async () => {
  await expect(generateShortSessionName(streamThatErrors(), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "stream-error" });
});
```

- [ ] **Step 2: Run the generator suite and record RED.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: current string results, 24-token/minimal options, and partial-text acceptance fail these assertions. This step intentionally exercises only the generator file; Task 5 updates the service caller to the new API.

- [ ] **Step 3: Replace the generator implementation and remove the obsolete import.** Keep the system prompt, single user message, `Date.now()`, `normalizeContext`, and `truncateInput` exactly as below. There is no catch around the factory or iteration: thrown errors must reach the runner.

```ts
export type SessionNameGeneration =
  | { ok: true; title: string }
  | {
      ok: false;
      reason:
        | "stream-error"
        | "no-completion"
        | "incomplete-stop"
        | "non-text-content"
        | "empty"
        | "unusable";
    };

export async function generateShortSessionName<TApi extends Api>(
  streamFn: StreamFn,
  model: Model<TApi>,
  firstMessage: string,
): Promise<SessionNameGeneration> {
  const context = {
    systemPrompt: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.",
    messages: [{
      role: "user" as const,
      content: `Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`,
      timestamp: Date.now(),
    }],
  };
  const stream = await streamFn(model, normalizeContext(context), {
    reasoning: "off",
    maxTokens: 256,
    signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
  });

  let finalMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "error") return { ok: false, reason: "stream-error" };
    if (event.type === "done") finalMessage = event.message;
  }
  if (finalMessage === undefined) return { ok: false, reason: "no-completion" };
  if (finalMessage.stopReason !== "stop") return { ok: false, reason: "incomplete-stop" };
  if (finalMessage.content.some((block) => block.type !== "text" && block.type !== "thinking")) {
    return { ok: false, reason: "non-text-content" };
  }
  const normalized = normalizeSessionName(textFromAssistant(finalMessage));
  if (normalized === undefined) return { ok: false, reason: "empty" };
  if (!isUsableSessionTitle(normalized)) return { ok: false, reason: "unusable" };
  return { ok: true, title: shortenSessionName(normalized) };
}
```

Keep `textFromAssistant(message: AssistantMessage): string` concatenating only text blocks with `.join("")`; it must not insert spaces or inspect thinking values. Do not call `stream.result()`, accumulate deltas, use `done.reason` for acceptance, or revalidate the display title. Remove `import type { ThinkingLevel } ...` completely.

- [ ] **Step 4: Run the generator suite and confirm GREEN.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: the new discriminated results and existing helper/relay/fallback cases pass. The missing-done fixture has a stored successful end message, so accepting `stream.result()` or deltas would fail it.

- [ ] **Step 5: Commit only the generator and its tests.**

```bash
git add src/server/sessions/sessionNameGenerator.ts src/server/sessions/sessionNameGenerator.test.ts
git commit -m "fix(sessions): accept only completed usable model titles"
```

## Task 4: Normalize utility attempts before deduplication through an opt-in seam

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessions/utilityModelResolver.ts:185-227` (`runWithUtilityModelFallback` signature and candidate-building loop only).
- Modify/Test: `src/server/sessions/utilityModelResolver.test.ts:390-480` (append two normalized fixtures; preserve both omitted-seam fixtures unchanged).

**Interfaces:**

- Consumes unchanged `UtilityModelIdentity = { provider: string; id: string }`, `UtilityModelAttempt<TModel extends UtilityModelIdentity> = { model: TModel; thinkingLevel: ThinkingLevel }`, and `UtilityModelTask = "lightweight" | "context"`.
- Consumes unchanged `UtilityModelResolver<TModel>` with `inspect(task: UtilityModelTask): Promise<UtilityModelInspection<TModel>>` and `configuredCandidates(task: UtilityModelTask): Promise<readonly ResolvedUtilityModel<TModel>[]>`; a resolved attempt also has `slot: UtilityModelTask`.
- Consumes existing file-local test types `FakeModel` and model fixtures `lightweight` (`acme/small`) and `context` (`acme/large`), plus the existing `fakeModel(provider: string, id: string, name: string): FakeModel` factory.
- Produces this exact additive signature, with the fifth parameter unmoved:

```ts
export async function runWithUtilityModelFallback<
  TModel extends UtilityModelIdentity,
  TResult,
>(
  resolver: UtilityModelResolver<TModel>,
  task: UtilityModelTask,
  activeAttempt: UtilityModelAttempt<TModel> | undefined,
  run: (attempt: UtilityModelAttempt<TModel>) => Promise<TResult | undefined> | TResult | undefined,
  onFailure?: (attempt: UtilityModelAttempt<TModel>, error: unknown) => void,
  normalizeAttempt?: (attempt: UtilityModelAttempt<TModel>) => UtilityModelAttempt<TModel>,
): Promise<TResult | undefined>;
```

- [ ] **Step 1: Add both normalized runner tests without editing the existing omitted-normalizer tests.** Use the existing imports for `UtilityModelAttempt`, `UtilityModelResolver`, `runWithUtilityModelFallback`, and `vi`.

```ts
it("normalizes every candidate before identity and execution", async () => {
  const configured = Object.freeze({
    model: Object.freeze({ ...lightweight }), thinkingLevel: "high" as const,
    slot: "lightweight" as const,
  });
  const active = Object.freeze({
    model: Object.freeze({ ...lightweight, name: "Active alias" }), thinkingLevel: "minimal" as const,
  });
  const candidates = Object.freeze([configured]);
  const resolver: UtilityModelResolver<FakeModel> = {
    inspect: vi.fn(() => Promise.resolve({ candidates, sessionModelOnly: false })),
    configuredCandidates: vi.fn(() => Promise.resolve(candidates)),
  };
  const normalizeAttempt = vi.fn((attempt: UtilityModelAttempt<FakeModel>): UtilityModelAttempt<FakeModel> => ({
    ...attempt, thinkingLevel: "off",
  }));
  const run = vi.fn<(attempt: UtilityModelAttempt<FakeModel>) => string | undefined>(() => undefined);
  await expect(runWithUtilityModelFallback(
    resolver, "lightweight", active, run, undefined, normalizeAttempt,
  )).resolves.toBeUndefined();

  expect(resolver.configuredCandidates).toHaveBeenCalledExactlyOnceWith("lightweight");
  expect(normalizeAttempt).toHaveBeenCalledTimes(2);
  expect(normalizeAttempt.mock.calls[0]?.[0]).toBe(configured);
  expect(normalizeAttempt.mock.calls[1]?.[0]).toBe(active);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[0]).toBe(normalizeAttempt.mock.results[0]?.value);
  expect(run.mock.calls[0]?.[0]).not.toBe(configured);
  expect(run.mock.calls[0]?.[0].model).toBe(configured.model);
  expect(run.mock.calls[0]?.[0].thinkingLevel).toBe("off");
  expect(configured).toEqual({ model: lightweight, thinkingLevel: "high", slot: "lightweight" });
  expect(active).toEqual({ model: { ...lightweight, name: "Active alias" }, thinkingLevel: "minimal" });
});

it("passes normalized attempts to exception diagnostics and preserves distinct identities", async () => {
  const first = Object.freeze({ model: Object.freeze({ ...lightweight }), thinkingLevel: "high" as const, slot: "lightweight" as const });
  const otherProvider = Object.freeze({ model: Object.freeze({ ...lightweight, provider: "other" }), thinkingLevel: "low" as const, slot: "context" as const });
  const active = Object.freeze({ model: Object.freeze({ ...context }), thinkingLevel: "minimal" as const });
  const candidates = Object.freeze([first, otherProvider]);
  const resolver: UtilityModelResolver<FakeModel> = {
    inspect: vi.fn(() => Promise.resolve({ candidates, sessionModelOnly: false })),
    configuredCandidates: vi.fn(() => Promise.resolve(candidates)),
  };
  const normalizeAttempt = vi.fn((attempt: UtilityModelAttempt<FakeModel>): UtilityModelAttempt<FakeModel> => ({
    ...attempt, thinkingLevel: "off",
  }));
  const failure = new Error("normalized attempt failed");
  const run = vi.fn<(attempt: UtilityModelAttempt<FakeModel>) => string | undefined>()
    .mockImplementationOnce(() => { throw failure; })
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce("active result");
  const onFailure = vi.fn();

  await expect(runWithUtilityModelFallback(
    resolver, "context", active, run, onFailure, normalizeAttempt,
  )).resolves.toBe("active result");
  expect(normalizeAttempt).toHaveBeenCalledTimes(3);
  expect(run.mock.calls.map(([attempt]) => [attempt.model.provider, attempt.model.id, attempt.thinkingLevel]))
    .toEqual([["acme", "small", "off"], ["other", "small", "off"], ["acme", "large", "off"]]);
  expect(run.mock.calls[0]?.[0].model).toBe(first.model);
  expect(run.mock.calls[1]?.[0].model).toBe(otherProvider.model);
  expect(run.mock.calls[2]?.[0].model).toBe(active.model);
  expect(onFailure).toHaveBeenCalledOnce();
  expect(onFailure).toHaveBeenCalledWith(run.mock.calls[0]?.[0], failure);
  expect(onFailure.mock.calls[0]?.[0]).toBe(run.mock.calls[0]?.[0]);
  expect(first.thinkingLevel).toBe("high");
  expect(otherProvider.thinkingLevel).toBe("low");
  expect(active.thinkingLevel).toBe("minimal");
});
```

- [ ] **Step 2: Run the resolver suite and record RED.**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`

Expected: the absent sixth-argument behavior leaves the normalizer uncalled and executes two same-identity/different-level attempts in the first fixture. The pre-existing omitted-seam cases still pass and must remain intact.

- [ ] **Step 3: Append the parameter and normalize each raw candidate before identity and storage.** Replace only the existing candidate loop with this body; keep resolution, `attemptKey`, sequential execution, `onFailure`, exhaustion, and return behavior unchanged.

```ts
// Add to the signature after onFailure:
normalizeAttempt?: (
  attempt: UtilityModelAttempt<TModel>,
) => UtilityModelAttempt<TModel>,

// Inside the function, after configured/candidates/seen initialization:
for (const rawAttempt of [
  ...configured,
  ...(activeAttempt === undefined ? [] : [activeAttempt]),
]) {
  const attempt = normalizeAttempt === undefined ? rawAttempt : normalizeAttempt(rawAttempt);
  const key = attemptKey(attempt);
  if (seen.has(key)) continue;
  seen.add(key);
  candidates.push(attempt);
}
```

The signature fragment above belongs in the existing parameter list; it is not a second declaration. The identity remains `JSON.stringify([attempt.model.provider, attempt.model.id, attempt.thinkingLevel])` inside the unchanged `attemptKey`. A normalizer runs once on every raw candidate, even a later duplicate, and no other call site opts in during this task.

- [ ] **Step 4: Run all resolver cases and confirm GREEN.**

Run: `npm test -- --run src/server/sessions/utilityModelResolver.test.ts`

Expected: both new fixtures pass and the omitted-seam cases still execute `acme/small/off → acme/large/xhigh → acme/small/minimal` with their original one exception callback and frozen-input assertions. The existing same-model/same-level undefined-result fixture still retains the first configured instance.

- [ ] **Step 5: Commit only the resolver and its tests.**

```bash
git add src/server/sessions/utilityModelResolver.ts src/server/sessions/utilityModelResolver.test.ts
git commit -m "refactor(models): add per-call attempt normalization before deduplication"
```

## Task 5: Wire title results into the service with scoped normalization and diagnostics

**Implementer tier:** Advanced

**Files:**

- Modify: `src/server/sessions/piSessionService.ts:5208-5267` (`maybeGenerateSessionName` callback, sixth runner argument, and settlement value only).
- Modify/Test: `src/server/sessions/piSessionService.promptQueue.test.ts:105-312` (existing title expectations and new rejected/exception cases), `:27-35` (one file-local fixture), and `:1015-1024` (`completedTitleStream` patch parameter).
- Read: `src/server/sessions/piSessionService.ts:5269-5319` (guarded application and deferred flushing; unchanged).

**Interfaces:**

- Consumes from Task 3: `generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<SessionNameGeneration>` where `SessionNameGeneration = { ok: true; title: string } | { ok: false; reason: "stream-error" | "no-completion" | "incomplete-stop" | "non-text-content" | "empty" | "unusable" }`.
- Consumes from Task 4: `runWithUtilityModelFallback<TModel extends UtilityModelIdentity, TResult>(resolver: UtilityModelResolver<TModel>, task: UtilityModelTask, activeAttempt: UtilityModelAttempt<TModel> | undefined, run: (attempt: UtilityModelAttempt<TModel>) => Promise<TResult | undefined> | TResult | undefined, onFailure?: (attempt: UtilityModelAttempt<TModel>, error: unknown) => void, normalizeAttempt?: (attempt: UtilityModelAttempt<TModel>) => UtilityModelAttempt<TModel>): Promise<TResult | undefined>` with attempt shape `{ model: TModel; thinkingLevel: ThinkingLevel }` and identity `{ provider: string; id: string }`.
- Consumes unchanged `deterministicSessionName(firstMessage: unknown): string | undefined`, `fallbackSessionName(firstMessage: unknown): string | undefined`, and private `applyGeneratedSessionName(session: PiAgentSession, name: string | undefined): void`.
- Preserves private `maybeGenerateSessionName(session: PiAgentSession, firstMessage: string): void` and all production name-application/event APIs.
- Produces file-local `titleServiceHarness(id: string, streamFn: StreamFn, candidates?: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[], sessionPatch?: NonNullable<Parameters<typeof fakeRuntime>[1]>): { service; fake; hub; resolver; logger; nameWrites }`, with the concrete return fields constructed in Step 1. This reuses the existing fakes rather than adding a helper file or shared framework.
- Extends file-local `completedTitleStream(modelId: string, text: string, patch?: Partial<AssistantMessage>): ReturnType<typeof createAssistantMessageEventStream>`; the patch changes the final message, not `done.reason`.
- Keeps existing file-local `utilityCandidate(model: ReturnType<typeof testModel>, thinkingLevel: ResolvedUtilityModel<ReturnType<typeof testModel>>["thinkingLevel"], slot?: ResolvedUtilityModel<ReturnType<typeof testModel>>["slot"]): ResolvedUtilityModel<ReturnType<typeof testModel>>` and `utilityResolverFor(candidates: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[]): { inspect; configuredCandidates }`.

- [ ] **Step 1: Extend the existing local fixtures and replace title-only configured-level assertions.** Add this helper after `utilityResolverFor`, and add the optional patch to `completedTitleStream`. Do not alter `failedTitleStream`, `deferredTitleStream`, runtime-factory setup, or the non-title `reasoning: "high"` assertion.

```ts
function titleServiceHarness(
  id: string,
  streamFn: StreamFn,
  candidates: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[] = [],
  sessionPatch: NonNullable<Parameters<typeof fakeRuntime>[1]> = {},
) {
  const fake = fakeRuntime(id, { ...sessionPatch, agent: { streamFunction: streamFn } });
  const hub = new CapturingSessionEventHub();
  const resolver = utilityResolverFor(candidates);
  const logger = { info: vi.fn<(details: Record<string, unknown>, message: string) => void>() };
  const nameWrites = vi.spyOn(fake.session, "setSessionName");
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    logger,
    utilityModelResolver: resolver,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord(id)]),
    heartbeatIntervalMs: 60_000,
  });
  return { service, fake, hub, resolver, logger, nameWrites };
}

function completedTitleStream(modelId: string, text: string, patch: Partial<AssistantMessage> = {}) {
  const stream = createAssistantMessageEventStream();
  const message = titleAssistantMessage(modelId, {
    content: [{ type: "text", text }],
    ...patch,
  });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}
```

For the existing configured-`high` success case, change its name to `uses the configured lightweight model with thinking off without changing active title state` and replace its request-options assertion with the first line below. Keep its configured `high`, active `high`, exact model identity, generated name/event, no-`setModel`, and no-`setThinkingLevel` assertions.

For the existing distinct-model failed-stream case, change its name to `keeps stream-error fallback to a distinct active model`, replace the two-element reasoning assertion with the second line, and add the budget assertion. For the existing same-model/same-level success case, use the first options assertion. For the active-only and narrowed-snapshot success cases, add that same options assertion after their model-call checks.

```ts
expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "off", maxTokens: 256 });
expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual(["off", "off"]);
expect(streamFn.mock.calls.map(([, , options]) => options?.maxTokens)).toEqual([256, 256]);
```

- [ ] **Step 2: Replace the different-level/two-call test with the discriminating rejected-path fixture.** The second-call success branch is essential; retain it exactly so delayed normalization is observable through both the title and call count.

```ts
it("deduplicates a rejecting same-model title fallback across thinking levels", async () => {
  const activeModel = testModel();
  let attempts = 0;
  const streamFn = vi.fn<StreamFn>((streamModel) => {
    attempts += 1;
    return attempts === 1
      ? failedTitleStream(streamModel.id)
      : completedTitleStream(streamModel.id, "Unexpected duplicate title");
  });
  const h = titleServiceHarness("level-distinct-name-session", streamFn,
    [utilityCandidate(activeModel, "high")], { model: activeModel });
  try {
    await h.service.prompt(sessionRef("level-distinct-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(h.fake.session.sessionName).toBe("Please fix the login bug"); });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[0]).toBe(activeModel);
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "off", maxTokens: 256 });
    expect(h.logger.info.mock.calls).toEqual([[
      { provider: activeModel.provider, modelId: activeModel.id, reason: "stream-error" },
      "utility title model rejected",
    ]]);
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Please fix the login bug");
  } finally {
    await h.service.dispose();
  }
});
```

- [ ] **Step 3: Add distinct completed-rejection and thrown-exception service cases.** These assert complete logger argument arrays, so extra fields, extra diagnostics, or conflating ordinary rejection with exceptions fail.

```ts
it("falls back from a rejected lightweight title to the active model with thinking off", async () => {
  const activeModel = testModel();
  const lightweightModel = { ...activeModel, id: "utility-lightweight" };
  const streamFn = vi.fn<StreamFn>((model) => model === lightweightModel
    ? completedTitleStream(model.id, "Fix login bug", { stopReason: "length" })
    : completedTitleStream(model.id, "Active model title"));
  const h = titleServiceHarness("rejected-name-session", streamFn,
    [utilityCandidate(lightweightModel, "high")], { model: activeModel });
  try {
    await h.service.prompt(sessionRef("rejected-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(h.fake.session.sessionName).toBe("Active model title"); });
    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel, activeModel]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual(["off", "off"]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.maxTokens)).toEqual([256, 256]);
    expect(h.logger.info.mock.calls).toEqual([[
      { provider: lightweightModel.provider, modelId: lightweightModel.id, reason: "incomplete-stop" },
      "utility title model rejected",
    ]]);
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Active model title");
    expect(h.hub.sessionEvents.some(({ event }) => event.type === "session.name" && event.name === "Active model title")).toBe(true);
    expect(h.fake.session.model).toBe(activeModel);
  } finally {
    await h.service.dispose();
  }
});

it("logs thrown attempt failures through the existing exception hook", async () => {
  const activeModel = testModel();
  const lightweightModel = { ...activeModel, id: "utility-lightweight" };
  const failure = new Error("utility title failed");
  const streamFn = vi.fn<StreamFn>((model) => {
    if (model === lightweightModel) throw failure;
    return completedTitleStream(model.id, "Active model title");
  });
  const h = titleServiceHarness("thrown-name-session", streamFn,
    [utilityCandidate(lightweightModel, "high")], { model: activeModel });
  try {
    await h.service.prompt(sessionRef("thrown-name-session"), "Please fix the login bug");
    await vi.waitFor(() => { expect(h.fake.session.sessionName).toBe("Active model title"); });
    expect(h.logger.info.mock.calls).toEqual([[
      { provider: lightweightModel.provider, modelId: lightweightModel.id,
        thinkingLevel: "off", error: "utility title failed" },
      "utility title model failed",
    ]]);
    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel, activeModel]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual(["off", "off"]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.maxTokens)).toEqual([256, 256]);
  } finally {
    await h.service.dispose();
  }
});
```

- [ ] **Step 4: Run the service suite and record RED before wiring.**

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: the unmigrated service tries to apply a result object and does not yet log rejections or supply the normalizer. The new same-model rejection fixture must not be weakened to make it green.

- [ ] **Step 5: Replace only the naming orchestration with this exact flow.** Keep the guard/relay/model-snapshot preamble in its current order; replace its runner/callback/settlement region as follows. Type inference must carry only the successful result to settlement, not `string | SessionNameGeneration`.

```ts
void runWithUtilityModelFallback(
  this.utilityModelResolver,
  "lightweight",
  { model, thinkingLevel: "minimal" },
  async (attempt) => {
    const result = await generateShortSessionName(
      session.agent.streamFunction,
      attempt.model,
      firstMessage,
    );
    if (result.ok) return result;
    this.logger.info(
      { provider: attempt.model.provider, modelId: attempt.model.id, reason: result.reason },
      "utility title model rejected",
    );
    return undefined;
  },
  (attempt, error) => {
    this.logger.info(
      {
        provider: attempt.model.provider,
        modelId: attempt.model.id,
        thinkingLevel: attempt.thinkingLevel,
        error: error instanceof Error ? error.message : String(error),
      },
      "utility title model failed",
    );
  },
  (attempt) => ({ ...attempt, thinkingLevel: "off" }),
)
  .then((result) => {
    this.applyGeneratedSessionName(session, result?.title ?? fallbackSessionName(firstMessage));
  })
  .catch((error: unknown) => {
    this.logger.info(
      { sessionId: session.sessionId, error: error instanceof Error ? error.message : String(error) },
      "failed to apply generated session name",
    );
  });
```

Do not rewrite `applyGeneratedSessionName`, `flushDeferredTreeNavigationWork`, `prompt`, any model-policy guard, or another runner call. Ordinary rejected results return `undefined` after the three-field log; they do not throw and do not reach `onFailure`. Thrown attempts see the normalized `off` level in the existing exception hook. Relay recognition still happens before `const model = session.model`, and a missing model returns before utility resolution and fallback extraction.

- [ ] **Step 6: Run the three focused suites, then typecheck.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/utilityModelResolver.test.ts`

Run: `npm run typecheck`

Expected: all pass; the service compiles against the three-argument generator and new sixth parameter. Existing active late-title, archived no-write, relay, bookkeeping failure, narrowed getter, and runtime-factory assertions remain green. Do not change the branch-summary `reasoning: "high"` assertion to `off`.

- [ ] **Step 7: Commit only the service and its test file.**

```bash
git add src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.promptQueue.test.ts
git commit -m "fix(sessions): normalize title attempts and log rejected completions"
```

## Task 6: Clean first-request scaffolding before the six-word fallback slice

**Implementer tier:** Standard

**Files:**

- Modify: `src/server/sessions/sessionNameGenerator.ts:52-62` (`fallbackSessionName` only).
- Modify/Test: `src/server/sessions/sessionNameGenerator.test.ts:126-138` (replace/extend the existing fallback cases; keep all relay cases unchanged).

**Interfaces:**

- Consumes from Task 1: `normalizeSessionName(value: string): string | undefined`, preserving first-line selection and quote/period cleanup.
- Consumes from Task 2: `shortenSessionName(value: string): string` and `cleanSessionName(value: string): string | undefined`, which composes normalization then display shortening without generated-title validation.
- Updates existing `fallbackSessionName(firstMessage: unknown): string | undefined`; its non-string boundary, six-token cap, existing removal regexes, and final `cleanSessionName` call stay intact.
- Preserves `deterministicSessionName(firstMessage: unknown): string | undefined` and every relay-specific private helper; the fallback must not call the relay recognizer.

- [ ] **Step 1: Add all scaffold and retained-content cases before implementation.** Keep the existing original first-request, skill-block, and missing-request fixtures; add the complete tables below in the same file. No input is a model-generated title in these cases.

```ts
it.each([
  ["PM: Bug: Utility models for session naming doesn't work", "Bug: Utility models for session naming"],
  ["Project manager: Fix the flaky login retry tests", "Fix the flaky login retry tests"],
  ["  pM :   Bug: Utility models for session naming doesn't work", "Bug: Utility models for session naming"],
  ["  pRoJeCt MaNaGeR : Fix the flaky login retry tests", "Fix the flaky login retry tests"],
])("strips a leading PM or project-manager marker from a fallback: %s", (input, expected) => {
  expect(fallbackSessionName(input)).toBe(expected);
});
it.each([
  "Model tier: Worker\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
  "PM:\nModel tier: Worker\n\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
  "PM:\r\nModel tier: Worker\r\n\r\nRole: Implementer\r\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
  "model TIER: Worker\r\n\r\nROLE: Implementer\r\nYou are the deterministic SDD lane runner for the f-worker lane of appio.",
])("strips leading tier and role metadata before the fallback slice: %s", (input) => {
  expect(fallbackSessionName(input)).toBe("deterministic SDD lane runner for the");
});
it.each([
  ["You are the deterministic SDD lane runner for the f-worker lane of appio.", "deterministic SDD lane runner for the"],
  ["You are an expert debugger for login failures", "expert debugger for login failures"],
  ["You are a coding assistant fixing login failures", "coding assistant fixing login failures"],
])("removes only the leading role introduction: %s", (input, expected) => {
  expect(fallbackSessionName(input)).toBe(expected);
});
it("keeps metadata after substantive request text", () => {
  expect(fallbackSessionName("Investigate failures\nRole: reviewer"))
    .toBe("Investigate failures Role: reviewer");
});
it("preserves existing first-request and skill-block fallbacks", () => {
  expect(fallbackSessionName("Seems like auto name for sessions is not working, I still get the first message as a name."))
    .toBe("Seems like auto name for sessions");
  expect(fallbackSessionName('<skill name="x" location="/x">\nDo x\n</skill>\n\nCheck the UI now'))
    .toBe("Check the UI now");
});
it.each([
  "```ts\nconst value = 1;\n```", "PM:", "Project manager:",
  "Model tier: Worker\nRole: Implementer",
  '<skill name="x" location="/x">\nDo x\n</skill>', " \n\t ", "",
])("returns no fallback for empty cleaned request %s", (input) => {
  expect(fallbackSessionName(input)).toBeUndefined();
});
it("returns no fallback for non-string requests", () => {
  for (const input of [undefined, null, 42, false, {}, []]) {
    expect(fallbackSessionName(input)).toBeUndefined();
  }
});
it("normalizes and shortens fallback text without model-title validation", () => {
  expect(fallbackSessionName("You are the deterministic SDD lane runner for the f-worker lane of appio."))
    .toBe("deterministic SDD lane runner for the");
  expect(fallbackSessionName("We need a session title")).toBe("We need a session title");
  expect(fallbackSessionName("x".repeat(61))).toBe("x".repeat(60));
  expect(fallbackSessionName("𠮷".repeat(61))).toBe("𠮷".repeat(60));
});
```

- [ ] **Step 2: Run the generator suite and record RED.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: the current fallback retains `PM:`, tier/role lines, and `You are` scaffolding; marker-only and metadata-only cases also fail. Retained substantive metadata and existing skill/code stripping remain controls.

- [ ] **Step 3: Replace only `fallbackSessionName` with the ordered cleanup.** Preserve line boundaries until after scaffold stripping. Strip exactly one leading PM marker and one leading introduction; repeatedly remove only leading metadata lines, including the final line without a newline.

```ts
export function fallbackSessionName(firstMessage: unknown): string | undefined {
  if (typeof firstMessage !== "string") return undefined;
  let request = firstMessage
    .replace(/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .trimStart()
    .replace(/^(?:PM|Project manager)\s*:\s*/i, "")
    .trimStart();
  const leadingMetadata = /^(?:Model tier|Role)\s*:[^\r\n]*(?:\r?\n|$)/i;
  while (leadingMetadata.test(request)) {
    request = request.replace(leadingMetadata, "").trimStart();
  }
  request = request.replace(/^You\s+are\s+(?:the|an|a)\b\s*/i, "");
  const words = request
    .replace(/[`*_#[\](){}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, FALLBACK_SESSION_NAME_MAX_WORDS)
    .join(" ");
  return cleanSessionName(words);
}
```

Do not call `isUsableSessionTitle` or use any rejected response text. The role description stays in the fallback, and `for the` or `We need` remains legal. An empty joined string flows through `cleanSessionName` to `undefined`, without a placeholder.

- [ ] **Step 4: Run focused fallback and service checks and confirm GREEN.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: all fallback examples match exactly and all existing service/generated-title cases pass. In particular the canonical relay results remain byte-for-byte unchanged and the no-prefix first-request fallback still uses six words.

- [ ] **Step 5: Commit only the generator and its test file.**

```bash
git add src/server/sessions/sessionNameGenerator.ts src/server/sessions/sessionNameGenerator.test.ts
git commit -m "fix(sessions): strip leading agent scaffolding from fallback names"
```

## Task 7: Complete and falsify the generator request and rejection matrix

**Implementer tier:** Standard

**Files:**

- Modify/Test: `src/server/sessions/sessionNameGenerator.test.ts:1-138` (add the remaining concrete acceptance cases using the existing local fakes; retain Tasks 1–3 and 6 cases).
- Probe only: `src/server/sessions/sessionNameGenerator.ts` (temporary, sequential branch mutations in Step 4; restore exact source bytes in `finally`; no production diff in this task).

**Interfaces:**

- Consumes from Task 3: `SessionNameGeneration = { ok: true; title: string } | { ok: false; reason: "stream-error" | "no-completion" | "incomplete-stop" | "non-text-content" | "empty" | "unusable" }` and `generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<SessionNameGeneration>`.
- Consumes local `fakeModel(): Model<Api>`, `fakeAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage`, `streamThatCompletes(text: string): StreamFn`, and `completedMessageStream(message: AssistantMessage, doneReason?: Extract<AssistantMessageEvent, { type: "done" }>["reason"], delta?: string): StreamFn` from Task 3. `doneReason` defaults to `"stop"`.
- Consumes helper exports `normalizeSessionName(value: string): string | undefined`, `isUsableSessionTitle(value: string): boolean`, `shortenSessionName(value: string): string`, `cleanSessionName(value: string): string | undefined`, `fallbackSessionName(firstMessage: unknown): string | undefined`, and `deterministicSessionName(firstMessage: unknown): string | undefined`; preserve their existing direct cases.
- Produces no production export or new test helper file. The only deliberately untyped provider fixture is the documented `externalContent(value: unknown): AssistantMessage["content"]` boundary below.

- [ ] **Step 1: Add the exact request-envelope, input-limit, and timestamp assertions.** Import `AssistantMessageEvent` as a type if it is not already imported. Restore both global spies in `finally`; the signal is controlled without fake clocks or waiting ten seconds.

```ts
it.each([
  ["x".repeat(4_000), "x".repeat(4_000)],
  ["x".repeat(4_001), "x".repeat(4_000) + "…"],
  ["𠮷".repeat(2_001), "𠮷".repeat(2_000) + "…"],
])("keeps the title timeout and input truncation unchanged", async (input, suffix) => {
  const signal = new AbortController().signal;
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
  const timestamp = 1_800_000_000_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(timestamp);
  const model = fakeModel();
  const streamFn = vi.fn<StreamFn>(streamThatCompletes("Fix login bug"));
  try {
    await expect(generateShortSessionName(streamFn, model, input))
      .resolves.toEqual({ ok: true, title: "Fix login bug" });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(streamFn).toHaveBeenCalledExactlyOnceWith(model, {
      messages: [
        { role: "system", content: "Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.", timestamp: 0 },
        { role: "user", content: `Create a 2-6 word title for this request:\n\n${suffix}`, timestamp },
      ],
    }, { reasoning: "off", maxTokens: 256, signal });
    expect(streamFn.mock.calls[0]?.[0]).toBe(model);
    expect(streamFn.mock.calls[0]?.[2]?.signal).toBe(signal);
    if (input.startsWith("𠮷")) {
      expect(suffix).toBe("𠮷".repeat(2_000) + "…");
      expect(Array.from(suffix)).toHaveLength(2_001);
    }
  } finally {
    now.mockRestore();
    timeout.mockRestore();
  }
});
```

The expected leading system message is the installed SDK's `normalizeContext` output; do not assert an obsolete top-level `systemPrompt` on the stream context.

- [ ] **Step 2: Add terminal, content, rejection-precedence, and thrown-exception cases.** The ordinary unknown block is intentionally outside the SDK content union. Keep its single cast confined to this documented fixture boundary, with a narrow lint exemption; no broad file-level disable or casts in normal fixtures.

```ts
// Provider/proxy boundary: exercise a block tag the SDK union cannot represent.
function externalContent(value: unknown): AssistantMessage["content"] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return value as AssistantMessage["content"];
}

it("uses final text blocks instead of partial deltas or thinking text", async () => {
  const message = fakeAssistantMessage({ content: [
    { type: "thinking", thinking: "We need a session title" },
    { type: "text", text: "Fix" }, { type: "text", text: "login bug" },
  ] });
  await expect(generateShortSessionName(completedMessageStream(message, "stop", "Wrong partial title"), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: true, title: "Fixlogin bug" });
});
it("accepts thinking plus a usable text title", async () => {
  const message = fakeAssistantMessage({ content: [
    { type: "thinking", thinking: "We need a session title" },
    { type: "text", text: "Fix login bug" },
  ] });
  await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: true, title: "Fix login bug" });
});
it.each(["toolUse", "deferred", "aborted", "error", "pending"] as const)("rejects non-answer terminal reason %s", async (stopReason) => {
  const message = fakeAssistantMessage({ stopReason, content: [{ type: "text", text: "Fix login bug" }] });
  await expect(generateShortSessionName(completedMessageStream(message, "stop"), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
});
it("accepts message stop despite a non-stop done reason", async () => {
  const message = fakeAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "Fix login bug" }] });
  await expect(generateShortSessionName(completedMessageStream(message, "length"), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: true, title: "Fix login bug" });
});
it.each(["toolCall", "unknown"] as const)("rejects non-text content type %s", async (type) => {
  const unexpected = type === "toolCall"
    ? { type: "toolCall", id: "call-1", name: "lookup", arguments: {} }
    : { type: "unknown" };
  const message = fakeAssistantMessage({ content: externalContent([
    { type: "text", text: "Fix login bug" }, unexpected,
  ]) });
  await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "non-text-content" });
});
it.each<{ content: AssistantMessage["content"] }>([
  { content: [] },
  { content: [{ type: "text", text: " \t " }] },
  { content: [{ type: "text", text: 'Title: ""' }] },
  { content: [{ type: "thinking", thinking: "We need a session title" }] },
])("classifies blank and thinking-only completions as empty", async ({ content }) => {
  await expect(generateShortSessionName(completedMessageStream(fakeAssistantMessage({ content })), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "empty" });
});
it("checks stop reason before tool content", async () => {
  const message = fakeAssistantMessage({ stopReason: "toolUse", content: [
    { type: "text", text: "Fix login bug" },
    { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
  ] });
  await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "incomplete-stop" });
});
it("checks content types before empty text", async () => {
  const message = fakeAssistantMessage({ content: [
    { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
    { type: "text", text: "   " },
  ] });
  await expect(generateShortSessionName(completedMessageStream(message), fakeModel(), "Fix login"))
    .resolves.toEqual({ ok: false, reason: "non-text-content" });
});
it("lets a thrown stream factory failure reach the caller", async () => {
  const failure = new Error("factory failed");
  const streamFn = vi.fn<StreamFn>(() => { throw failure; });
  await expect(generateShortSessionName(streamFn, fakeModel(), "Fix login")).rejects.toBe(failure);
});
it("lets a thrown stream iteration failure reach the caller", async () => {
  const failure = new Error("iteration failed");
  const message = fakeAssistantMessage({ content: [{ type: "text", text: "Fix login bug" }] });
  const stream = createAssistantMessageEventStream();
  stream.end(message);
  const iterator = vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(async function* (): AsyncGenerator<AssistantMessageEvent> {
    yield { type: "text_delta", contentIndex: 0, delta: "Fix login bug", partial: message };
    await Promise.resolve();
    throw failure;
  });
  try {
    await expect(generateShortSessionName(() => stream, fakeModel(), "Fix login")).rejects.toBe(failure);
  } finally {
    iterator.mockRestore();
  }
});
```

- [ ] **Step 3: Add the full generated-title structural/display cases.** These complement the direct predicate tests and pin the pipeline order rather than merely the helper implementations.

```ts
it("validates the entire title before shortening", async () => {
  const title = "Investigate strange session naming behavior across providers before generating final answers";
  expect(title.split(/\s+/)).toHaveLength(11);
  expect(title.slice(0, 60)).toBe("Investigate strange session naming behavior across providers");
  await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: false, reason: "unusable" });
});
it.each([
  "No quotes please", "Remove punctuation wrapper", "Create a 2-6 word title", "Create a 2-6 words title",
  "The user wants login fixes", "We need a session title", "Need to produce title", "Need to infer title",
  "Need to craft title", "Fix login because we need retries",
])("rejects reasoning echo %s", async (title) => {
  await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: false, reason: "unusable" });
});
it.each<[number, string]>([
  [1, "Login"], [7, "Fix flaky article bridge FTS retry test"],
  [8, "Fix flaky article bridge FTS retry test failures"],
])("accepts a legitimate %s-word title", async (count, title) => {
  expect(title.split(/\s+/)).toHaveLength(count);
  await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: true, title });
});
it("rejects a nine-word title", async () => {
  await expect(generateShortSessionName(streamThatCompletes("Fix flaky article bridge FTS retry test failures today"), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: false, reason: "unusable" });
});
it.each(["and", "or", "for", "the", "a", "an", "to", "with", "of", "in", "on", "by", "With,"])("rejects dangling connector %s", async (connector) => {
  await expect(generateShortSessionName(streamThatCompletes(`Fix login ${connector}`), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: false, reason: "unusable" });
});
it("accepts a connector substring in a complete word", async () => {
  await expect(generateShortSessionName(streamThatCompletes("Fix login within"), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: true, title: "Fix login within" });
});
it("shortens only after accepting a long legitimate title", async () => {
  await expect(generateShortSessionName(streamThatCompletes("Improve authentication reliability across distributed production environments"), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: true, title: "Improve authentication reliability across distributed" });
});
it("never revalidates the shortened display value", async () => {
  const title = "Investigate authentication failures across providers and document recovery";
  expect(title.split(/\s+/)).toHaveLength(8);
  await expect(generateShortSessionName(streamThatCompletes(title), fakeModel(), "Fix naming"))
    .resolves.toEqual({ ok: true, title: "Investigate authentication failures across providers and" });
});
it.each(["x", "𠮷"])("accepts and caps a long unspaced title: %s", async (character) => {
  const result = await generateShortSessionName(streamThatCompletes(character.repeat(61)), fakeModel(), "Fix naming");
  expect(result).toEqual({ ok: true, title: character.repeat(60) });
  if (!result.ok) throw new Error("Expected an accepted unspaced title");
  expect(Array.from(result.title)).toHaveLength(60);
  if (character === "𠮷") expect(result.title).toHaveLength(120);
});
```

- [ ] **Step 4: Run the expanded suite, then prove three independent negative controls against the earlier implementation.**

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Expected: GREEN where Tasks 1–3 and 6 already implement the contract. Record the actual result; acceptance coverage does not justify fabricating a failing run. Then use this disposable, sequential in-process mutation driver from the repository root. It creates no helper file, mutates one existing source branch at a time, requires an assertion failure from the named test, and restores the original bytes in `finally` before any next mutation. Do not run another test process concurrently.

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const path = "src/server/sessions/sessionNameGenerator.ts";
const original = readFileSync(path, "utf8");
const probes = [
  ["finalMessage.stopReason !== \"stop\"", "false", "rejects non-answer terminal reason"],
  ["!isUsableSessionTitle(normalized)", "!isUsableSessionTitle(shortenSessionName(normalized))", "validates the entire title before shortening"],
  ["return { ok: true, title: shortenSessionName(normalized) };",
   "const title = shortenSessionName(normalized); return isUsableSessionTitle(title) ? { ok: true, title } : { ok: false, reason: \"unusable\" };",
   "never revalidates the shortened display value"],
];
for (const [before, after, name] of probes) {
  if (original.split(before).length !== 2) throw new Error(`Non-unique mutation anchor: ${before}`);
  try {
    writeFileSync(path, original.replace(before, after));
    const result = spawnSync("npm", ["test", "--", "--run", "src/server/sessions/sessionNameGenerator.test.ts", "-t", name], { encoding: "utf8", timeout: 60_000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);
    if (result.status !== 1 || !output.includes("AssertionError") || !output.includes(name)) {
      throw new Error(`Mutation was not killed by the expected assertion: ${name}`);
    }
  } finally {
    writeFileSync(path, original);
  }
}
NODE
```

If a source-formatting change makes an anchor non-unique/missing, stop that probe and locate its equivalent single statement before continuing; do not treat an import/parse failure or timeout as a killed mutation. No temporary mutation is committed.

- [ ] **Step 5: Confirm restoration and GREEN, then commit the test-only coverage.**

Run: `git diff --exit-code -- src/server/sessions/sessionNameGenerator.ts`

Run: `npm test -- --run src/server/sessions/sessionNameGenerator.test.ts`

Run: `npx eslint src/server/sessions/sessionNameGenerator.test.ts`

Expected: original source bytes restored, the complete expanded matrix passes, and the documented single boundary cast is the only new type assertion. No generation call has a fourth argument or an old string/undefined expectation.

```bash
git add src/server/sessions/sessionNameGenerator.test.ts
git commit -m "test(sessions): cover title completion and display contracts"
```

## Task 8: Complete service exhaustion, no-model, and late-application coverage

**Implementer tier:** Advanced

**Files:**

- Modify/Test: `src/server/sessions/piSessionService.promptQueue.test.ts:105-409` (remaining concrete naming matrix and tree-deferral regression; keep unrelated prompt/auth/runtime-factory tests intact).
- Modify: the same test file's type-import line at baseline `:15` only if `PiAgentSession` is needed for the typed tree fixture.
- Probe only: `src/server/sessions/piSessionService.ts:5230-5264` and `src/server/sessions/utilityModelResolver.ts:204-216` (two sequential deduplication mutations in Step 4; restore exact bytes; no production diff).
- Read unchanged: `src/server/sessions/piSessionService.tree.test.ts`, `src/server/sessions/utilityModelExtension.test.ts`, and `src/server/speechInput/speechInputPolishingService.test.ts` (acceptance guards; do not modify these files).

**Interfaces:**

- Consumes from Task 5: file-local `titleServiceHarness(id: string, streamFn: StreamFn, candidates?: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[], sessionPatch?: NonNullable<Parameters<typeof fakeRuntime>[1]>): { service: PiSessionService; fake: ReturnType<typeof fakeRuntime>; hub: CapturingSessionEventHub; resolver: ReturnType<typeof utilityResolverFor>; logger: { info: ReturnType<typeof vi.fn<(details: Record<string, unknown>, message: string) => void>> }; nameWrites: ReturnType<typeof vi.spyOn> }`. Use its inferred return type in code rather than adding this descriptive type annotation.
- Consumes from Task 5: `completedTitleStream(modelId: string, text: string, patch?: Partial<AssistantMessage>): ReturnType<typeof createAssistantMessageEventStream>`; its patch sets final `stopReason` while `done.reason` remains `"stop"`.
- Consumes existing `failedTitleStream(modelId: string): ReturnType<typeof createAssistantMessageEventStream>`, `deferredTitleStream(modelId: string): { stream: ReturnType<typeof createAssistantMessageEventStream>; complete(text: string): void }`, and `flushPendingMicrotasks(): Promise<void>`.
- Consumes existing `utilityCandidate(model: ReturnType<typeof testModel>, thinkingLevel: ResolvedUtilityModel<ReturnType<typeof testModel>>["thinkingLevel"], slot?: ResolvedUtilityModel<ReturnType<typeof testModel>>["slot"]): ResolvedUtilityModel<ReturnType<typeof testModel>>` and `utilityResolverFor(candidates: readonly ResolvedUtilityModel<ReturnType<typeof testModel>>[]): { inspect; configuredCandidates }`.
- Consumes unchanged private `maybeGenerateSessionName(session: PiAgentSession, firstMessage: string): void` through bracket access for the specified no-model boundary only; public `service.prompt`, `service.status`, and `service.navigateTree` remain unchanged.
- Consumes existing `deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }` and `NonNullable<PiAgentSession["navigateTree"]>` for the tree-navigation fixture.
- Produces no production API or additional scheduling; proves the existing service application path consumes accepted results and `fallbackSessionName(firstMessage: unknown): string | undefined` correctly.

- [ ] **Step 1: Add one concrete exhaustion fixture that proves both final rejection diagnostics and the exact cleaned fallback.** The specification permits those two matrix rows to share a fixture when all assertions remain present; this case includes both normal name-publication channels. Also add the same-model/different-level positive control.

```ts
it("logs every rejected title attempt including the last before fallback", async () => {
  const id = "exhausted-name-session";
  const activeModel = testModel();
  const lightweightModel = { ...activeModel, id: "utility-lightweight" };
  const streamFn = vi.fn<StreamFn>((model) => model === lightweightModel
    ? completedTitleStream(model.id, "Fix login bug", { stopReason: "length" })
    : completedTitleStream(model.id, "We need a session title"));
  const h = titleServiceHarness(id, streamFn,
    [utilityCandidate(lightweightModel, "high")], { model: activeModel });
  const expectedName = "Bug: Utility models for session naming";
  try {
    await h.service.prompt(sessionRef(id), "PM: Bug: Utility models for session naming doesn't work");
    await vi.waitFor(() => { expect(h.fake.session.sessionName).toBe(expectedName); });
    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel, activeModel]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.reasoning)).toEqual(["off", "off"]);
    expect(streamFn.mock.calls.map(([, , options]) => options?.maxTokens)).toEqual([256, 256]);
    expect(h.logger.info.mock.calls).toEqual([
      [{ provider: lightweightModel.provider, modelId: lightweightModel.id, reason: "incomplete-stop" }, "utility title model rejected"],
      [{ provider: activeModel.provider, modelId: activeModel.id, reason: "unusable" }, "utility title model rejected"],
    ]);
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith(expectedName);
    const nameEvent = { type: "session.name", sessionId: id, name: expectedName };
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name").map(({ event }) => event)).toEqual([nameEvent]);
    expect(h.hub.globalEvents.filter((event) => event.type === "session.name")).toEqual([nameEvent]);
  } finally {
    await h.service.dispose();
  }
});

it("accepts one same-model title attempt across thinking levels", async () => {
  const id = "same-model-success-session";
  const activeModel = testModel();
  const streamFn = vi.fn<StreamFn>((model) => completedTitleStream(model.id, "Shared title"));
  const h = titleServiceHarness(id, streamFn,
    [utilityCandidate(activeModel, "high")], { model: activeModel });
  try {
    await h.service.prompt(sessionRef(id), "Please fix the login bug");
    await vi.waitFor(() => { expect(h.fake.session.sessionName).toBe("Shared title"); });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[0]).toBe(activeModel);
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({ reasoning: "off", maxTokens: 256 });
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Shared title");
    expect(h.logger.info).not.toHaveBeenCalled();
  } finally {
    await h.service.dispose();
  }
});
```

- [ ] **Step 2: Add settled empty-fallback outcomes and the exact no-model/relay boundary.** Await two executed attempts, both rejection records, and the existing microtask-flush pattern before negative name/event assertions. Register the no-model runtime while it has a normal model, then clear the model only for the private boundary; do not alter public prompt-policy authorization or use a changing-getter workaround.

```ts
it.each([
  "```ts\nconst value = 1;\n```", "PM:", "Model tier: Worker\nRole: Implementer",
])("stays unnamed when every attempt rejects and the fallback is empty for %s", async (request) => {
  const id = "empty-name-session";
  const activeModel = testModel();
  const lightweightModel = { ...activeModel, id: "utility-lightweight" };
  const streamFn = vi.fn<StreamFn>((model) => model === lightweightModel
    ? completedTitleStream(model.id, "Fix login bug", { stopReason: "length" })
    : completedTitleStream(model.id, "We need a session title"));
  const h = titleServiceHarness(id, streamFn,
    [utilityCandidate(lightweightModel, "high")], { model: activeModel });
  try {
    await h.service.prompt(sessionRef(id), request);
    await vi.waitFor(() => {
      expect(streamFn).toHaveBeenCalledTimes(2);
      expect(h.logger.info).toHaveBeenCalledTimes(2);
    });
    await flushPendingMicrotasks();
    expect(h.fake.session.sessionName).toBeUndefined();
    expect(h.nameWrites).not.toHaveBeenCalled();
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name")).toEqual([]);
    expect(h.hub.globalEvents.filter((event) => event.type === "session.name")).toEqual([]);
    expect(streamFn.mock.calls.map(([model]) => model)).toEqual([lightweightModel, activeModel]);
    expect(h.logger.info.mock.calls).toEqual([
      [{ provider: lightweightModel.provider, modelId: lightweightModel.id, reason: "incomplete-stop" }, "utility title model rejected"],
      [{ provider: activeModel.provider, modelId: activeModel.id, reason: "unusable" }, "utility title model rejected"],
    ]);
  } finally {
    await h.service.dispose();
  }
});

it("does not attempt naming without a resolved session model", async () => {
  const id = "no-model-name-session";
  const activeModel = testModel();
  const lightweightModel = { ...activeModel, id: "utility-lightweight" };
  const streamFn = vi.fn<StreamFn>(() => { throw new Error("title stream should not run"); });
  const h = titleServiceHarness(id, streamFn,
    [utilityCandidate(lightweightModel, "high")], { model: activeModel });
  try {
    await h.service.status(sessionRef(id));
    h.fake.session.model = undefined;
    h.service["maybeGenerateSessionName"](h.fake.session, "Please fix the login bug");
    await flushPendingMicrotasks();
    expect(h.resolver.inspect).not.toHaveBeenCalled();
    expect(h.resolver.configuredCandidates).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
    expect(h.nameWrites).not.toHaveBeenCalled();
    expect(h.fake.session.sessionName).toBeUndefined();
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name")).toEqual([]);
    expect(h.hub.globalEvents.filter((event) => event.type === "session.name")).toEqual([]);
    expect(h.logger.info).not.toHaveBeenCalled();

    // Companion call proves canonical relay precedence over the no-model return.
    h.service["maybeGenerateSessionName"](h.fake.session,
      'Relay "handoff-check" leg 2 begins now.\n\nYou are the next runner.');
    expect(h.fake.session.sessionName).toBe("Relay handoff-check leg 2");
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Relay handoff-check leg 2");
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name").map(({ event }) => event))
      .toEqual([{ type: "session.name", sessionId: id, name: "Relay handoff-check leg 2" }]);
    expect(h.resolver.configuredCandidates).not.toHaveBeenCalled();
    expect(h.resolver.inspect).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
  } finally {
    h.fake.session.model = activeModel;
    await h.service.dispose();
  }
});
```

- [ ] **Step 3: Pin deferred application and an existing name winning over a late title.** Add `type PiAgentSession` to the existing service import, then add these tests. Preserve the existing active late-title, archived no-write, outer bookkeeping-error, narrowed-model snapshot, and canonical relay tests with their original outcomes. Rename the existing active-only test to `uses only the active model when no utility candidate is configured`, retaining its new `off`/256 assertion from Task 5.

```ts
it("defers a generated title until tree navigation settles", async () => {
  const id = "tree-deferred-title-session";
  const activeModel = testModel();
  const title = deferredTitleStream(activeModel.id);
  const navigation = deferred<{ cancelled: boolean }>();
  const navigateTree = vi.fn<NonNullable<PiAgentSession["navigateTree"]>>(() => navigation.promise);
  const streamFn = vi.fn<StreamFn>(() => title.stream);
  const h = titleServiceHarness(id, streamFn, [], { model: activeModel, navigateTree });
  let navigating: Promise<unknown> | undefined;
  try {
    await h.service.prompt(sessionRef(id), "Please fix the login bug");
    await vi.waitFor(() => { expect(streamFn).toHaveBeenCalledOnce(); });
    await flushPendingMicrotasks();
    navigating = h.service.navigateTree(sessionRef(id), {
      targetId: "target-1", expectedLeafId: "leaf-1", summary: { mode: "none" },
    });
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
    title.complete("Deferred title");
    await flushPendingMicrotasks();
    expect(h.nameWrites).not.toHaveBeenCalled();
    expect(h.fake.session.sessionName).toBeUndefined();
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name")).toEqual([]);
    navigation.resolve({ cancelled: false });
    await navigating;
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Deferred title");
    expect(h.fake.session.sessionName).toBe("Deferred title");
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name").map(({ event }) => event))
      .toEqual([{ type: "session.name", sessionId: id, name: "Deferred title" }]);
  } finally {
    navigation.resolve({ cancelled: false });
    try { await navigating; } finally { await h.service.dispose(); }
  }
});

it("preserves an existing name set while title generation is pending", async () => {
  const id = "manual-late-title-session";
  const activeModel = testModel();
  const title = deferredTitleStream(activeModel.id);
  const streamFn = vi.fn<StreamFn>(() => title.stream);
  const h = titleServiceHarness(id, streamFn, [], { model: activeModel });
  try {
    await h.service.prompt(sessionRef(id), "Please fix the login bug");
    await vi.waitFor(() => { expect(streamFn).toHaveBeenCalledOnce(); });
    h.fake.session.setSessionName("Manual name");
    title.complete("Deferred title");
    await flushPendingMicrotasks();
    expect(h.fake.session.sessionName).toBe("Manual name");
    expect(h.nameWrites).toHaveBeenCalledExactlyOnceWith("Manual name");
    expect(h.hub.sessionEvents.filter(({ event }) => event.type === "session.name")).toEqual([]);
    expect(h.hub.globalEvents.filter((event) => event.type === "session.name")).toEqual([]);
  } finally {
    await h.service.dispose();
  }
});
```

The manual name uses the fake's setter only, so it intentionally publishes no event; this checks that later automatic application does not publish one either. The tree test goes through public prompt/navigation methods and the existing guarded application path, not private collection mutation.

- [ ] **Step 4: Run the service matrix, then falsify normalization ordering with two independent probes.**

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: GREEN after the previous tasks; record real acceptance results. Then run this sequential mutation driver from the repository root. Each mutation must fail the rejected-path deduplication case on an assertion, not a timeout/loader error. Keep the deliberately successful duplicate request in that test.

```bash
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const name = "deduplicates a rejecting same-model title fallback across thinking levels";
const probes = [
  ["src/server/sessions/utilityModelResolver.ts", "const key = attemptKey(attempt);", "const key = attemptKey(rawAttempt);"],
  ["src/server/sessions/piSessionService.ts", '(attempt) => ({ ...attempt, thinkingLevel: "off" }),', "(attempt) => attempt,"],
];
for (const [path, before, after] of probes) {
  const original = readFileSync(path, "utf8");
  if (original.split(before).length !== 2) throw new Error(`Non-unique mutation anchor: ${path}`);
  try {
    writeFileSync(path, original.replace(before, after));
    const result = spawnSync("npm", ["test", "--", "--run", "src/server/sessions/piSessionService.promptQueue.test.ts", "-t", name], { encoding: "utf8", timeout: 60_000 });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);
    if (result.status !== 1 || !output.includes("AssertionError") || !output.includes(name)) {
      throw new Error(`Mutation was not killed by the expected assertion: ${path}`);
    }
  } finally {
    writeFileSync(path, original);
  }
}
NODE
```

A missing anchor is a probe setup failure: locate the single equivalent statement before retrying. Neither mutated production file belongs in this task's commit.

- [ ] **Step 5: Confirm restoration and run the focused scope-boundary suites unchanged.**

Run: `git diff --exit-code -- src/server/sessions/piSessionService.ts src/server/sessions/utilityModelResolver.ts`

Run: `npm test -- --run src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/utilityModelResolver.test.ts src/server/sessions/piSessionService.tree.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/speechInput/speechInputPolishingService.test.ts`

Run: `npx eslint src/server/sessions/piSessionService.promptQueue.test.ts`

Expected: all pass. The resolver's omitted-seam tests are the proof against globally forced `off`; the unchanged branch-summary/compaction suite proves consumers still forward candidate levels; the unchanged polishing suite proves its existing `off` clamp remains. These are distinct checks because the consumer suites inject resolver fakes and do not exercise the shared runner.

- [ ] **Step 6: Commit only the service test file.**

```bash
git add src/server/sessions/piSessionService.promptQueue.test.ts
git commit -m "test(sessions): pin title fallback diagnostics and lifecycle boundaries"
```

## Task 9: Add the patch Changeset and record complete implementation acceptance

**Implementer tier:** Standard

**Files:**

- Create: `.changeset/fix-utility-session-naming.md`.
- Read/verify only: `src/server/sessions/sessionNameGenerator.ts`, `src/server/sessions/utilityModelResolver.ts`, `src/server/sessions/piSessionService.ts`, their three modified test files, and the three unchanged scope-boundary/tree suites named in Step 2.
- Keep unchanged: `CHANGELOG.md`, `package.json`, `package-lock.json`, all specs/designs/plans, and all non-title production consumers. Do not publish, restart services, or add an implementation-report file.

**Interfaces:**

- Consumes the completed exported contracts: `generateShortSessionName<TApi extends Api>(streamFn: StreamFn, model: Model<TApi>, firstMessage: string): Promise<SessionNameGeneration>`, where `SessionNameGeneration = { ok: true; title: string } | { ok: false; reason: "stream-error" | "no-completion" | "incomplete-stop" | "non-text-content" | "empty" | "unusable" }`; `normalizeSessionName(value: string): string | undefined`; `isUsableSessionTitle(value: string): boolean`; `shortenSessionName(value: string): string`; `cleanSessionName(value: string): string | undefined`; `fallbackSessionName(firstMessage: unknown): string | undefined`; unchanged `deterministicSessionName(firstMessage: unknown): string | undefined`.
- Consumes the additive runner contract: `runWithUtilityModelFallback<TModel extends UtilityModelIdentity, TResult>(resolver: UtilityModelResolver<TModel>, task: UtilityModelTask, activeAttempt: UtilityModelAttempt<TModel> | undefined, run: (attempt: UtilityModelAttempt<TModel>) => Promise<TResult | undefined> | TResult | undefined, onFailure?: (attempt: UtilityModelAttempt<TModel>, error: unknown) => void, normalizeAttempt?: (attempt: UtilityModelAttempt<TModel>) => UtilityModelAttempt<TModel>): Promise<TResult | undefined>`; only session-title orchestration supplies the normalizer.
- Produces exactly one Changesets fragment declaring `"@hyperdreamer/pi-webui": patch`, plus a handoff in the completion message containing observed command results and the manual session-daemon restart requirement. No version files or public API changes.

- [ ] **Step 1: Add the exact user-facing patch fragment.** Read `.agents/skills/changeset-changelog/SKILL.md` before editing; create this file manually rather than running an interactive version/publish command.

````md
---
"@hyperdreamer/pi-webui": patch
---

Fix automatic session titles by rejecting incomplete or unusable model output and cleaning fallback names.
````

There is no new behavior to implement or failing test to invent in this release-note task. The fragment records the already implemented user-visible fix.

- [ ] **Step 2: Run the focused matrix, unchanged boundary suites, typecheck, then routine broad verification.** Run these commands sequentially, recording their exact exit results. Do not run full suites beside another heavy test process or subsession.

```bash
npm test -- --run src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/utilityModelResolver.test.ts
npm test -- --run src/server/sessions/piSessionService.tree.test.ts src/server/sessions/utilityModelExtension.test.ts src/server/speechInput/speechInputPolishingService.test.ts
npm run typecheck
npm run verify:fast
```

Expected: all commands exit 0. The broad command already includes typecheck, lint, Knip, and the fast full test suite; do not add an additional full suite once it passes unless new edits or unresolved failures justify it. Do not change the unchanged consumer fixtures to make a boundary failure pass.

- [ ] **Step 3: Review the final production scope and exact acceptance evidence.** Run `git diff --check` and inspect the implementation commits' diff, not just the final fragment. The following checklist is a specification-to-task coverage map for the review; it is not another task heading or a substitute for assertions.

| Requirement | Implementation and concrete proof |
| --- | --- |
| Uncapped normalization; one/eight-word bounds; all whole-word echoes and exact final connectors | Task 1 helpers and Task 7 completed-result cases. |
| 60 Unicode code points, cutoff whitespace inclusive, no punctuation stripping or ellipsis | Task 2 helper cases; Task 7 accepted unspaced/long-display cases. |
| Three-argument API and exact discriminated union; ordered error/done/stop/content/empty/unusable/success decisions | Task 3 implementation; Task 7 all terminal/content/precedence/exception cases. |
| Explicit off, 256 tokens, one supplied-model call, 10-second signal, exact prompts/timestamp and UTF-16 input truncation | Tasks 3 and 7, including the 2,001-supplementary-character input fixture. |
| Final block concatenation without separators; positive thinking plus text; no delta/stored-result rescue | Task 3 no-done fixture and Task 7 final-text/thinking cases. |
| Validate full text before shortening and never revalidate display text | Task 7 eleven-word and connector-ending display fixtures plus their independent killed mutations. |
| Sixth optional normalizer; normalize every raw candidate before key/storage; first instance wins; frozen inputs unchanged | Task 4 tests and scoped loop change. |
| Existing omitted-seam level-distinct and same-level behavior preserved; distinct provider/ID controls | Task 4 retained compatibility tests and normalized exception-order test. |
| Title-only off normalization; snapshot active model and minimal active-attempt shape retained | Task 5 wiring and state/snapshot tests; Task 8 rejected-path ordering mutations. |
| Exact three-field ordinary-rejection records including last rejection; existing exception and outer failure logs | Task 5 distinct rejection/throw tests; Task 8 exhaustion case; retained bookkeeping-error test. |
| Exact PM/role/tier cleanup order, LF/CRLF, role description retained, six words before cleanup, no generated predicate on fallback | Task 6 complete fallback tables and Task 8 exact PM service fallback. |
| All rejected plus empty request remains unnamed with no writes/events, after settlement | Task 8 three empty-input rows. |
| No-model prerequisite before resolution/fallback; canonical relay before no-model return | Task 8 registered-runtime private-boundary test and its companion no-model relay invocation. |
| Canonical/long/noncanonical relay outputs unchanged; no title code-point change to relay truncation | Retained generator relay tests in Tasks 1–2/6, retained service relay case. |
| Entry guards, existing names, active late writes, archive/replacement safety, tree deferral/flush/error containment | Task 5 restricts production edits to orchestration; retained lifecycle tests and Task 8 deferred-tree/manual-name cases; unchanged tree suite. |
| Branch summaries/compaction retain configured levels; context unchanged; polishing clamp unchanged | Omitted-seam resolver tests plus unchanged `utilityModelExtension.test.ts` and `speechInputPolishingService.test.ts`; runtime-factory `high` assertion preserved. |
| One patch Changeset, no changelog/version/publishing edits, daemon restart handoff | This task. |

Inspect only the approved production surfaces and six-file implementation/test scope plus the one Changeset. Keep `applyGeneratedSessionName`, `flushDeferredTreeNavigationWork`, relay helpers, resolver eligibility/refresh/slot selection, `attemptKey`, non-title utility consumers, and prompt-policy code byte-for-byte unchanged. Verify mutation probes restored the source and no temporary fixture/helper files survived. The only generator API call in production must have three arguments; title-only test option expectations must all use `off`/256 while the runtime-factory branch-summary expectation stays `high`.

- [ ] **Step 4: Commit only the patch fragment.**

```bash
git add .changeset/fix-utility-session-naming.md
git commit -m "fix(sessions): document automatic title generation repair"
```

- [ ] **Step 5: Hand off observed evidence and the runtime restart requirement.** Report the exact focused, unchanged-boundary, typecheck, and `verify:fast` results; the killed normalization-order and generator-order mutation names; the patch fragment path; and any unresolved failure without claiming completion. State: `A manual restart of pi-webui-sessiond.service is required for the new naming behavior; UI/API autoreload alone does not reload this runtime code.` Do not restart the daemon from the implementation task because it owns long-lived sessions.
