# Utility-Model Session Naming Specification

**Date:** 2026-10-30  
**Status:** technical specification; implementation pending  
**Source of truth:** [Utility-Model Session Naming Design](2026-10-30-utility-session-naming-design.md) (approved; design review PASSED)

## Background

Automatic naming currently requests 24 output tokens, forwards the utility thinking level, accepts partial streamed text without a completed answer, and truncates candidates before checking whether they resemble titles. A reasoning model can spend that budget on thinking; a proxy can expose the truncated reasoning as text. The resulting session name is either a reasoning fragment or an unhelpful first-message slice containing agent scaffolding.

This specification implements the approved design within the existing injected-stream and utility-fallback boundaries. Generated titles must satisfy the completion and format contract before display shortening. Rejected attempts advance through the existing fallback chain and produce structured diagnostics. If no model attempt succeeds, the service derives a deterministic name from the cleaned first request.

## Goal and scope

For an eligible unnamed session with a resolved session model, naming produces either an accepted generated title or a recognizable six-word fallback derived from the first request. If every attempt is rejected and the request cleans to nothing, the session intentionally remains unnamed; the existing session list continues to display its first message.

The guarantee is structural. The observed instruction/reasoning echoes listed below must be rejected, including when a provider exposes them as text. A short reasoning sentence that satisfies every structural rule can still pass; this change does not introduce semantic classification.

A resolved session model remains a prerequisite for model-based naming and the first-message fallback. The canonical relay-handoff name is checked before that prerequisite and keeps precedence.

Implementation is confined to:

- `src/server/sessions/sessionNameGenerator.ts`;
- `src/server/sessions/utilityModelResolver.ts`, adding an optional per-invocation attempt normalizer;
- `src/server/sessions/piSessionService.ts`, within naming orchestration;
- the existing generator, prompt-queue service, and resolver test files specified below;
- one patch Changeset for the implemented user-visible fix.

No new runtime dependency or public configuration surface is required.

## TypeScript contracts

### Session-name generator exports

Use `Api` and `Model` from `@earendil-works/pi-ai` and `StreamFn` from `@earendil-works/pi-agent-core`. The following are the exact required exported types and function signatures in `sessionNameGenerator.ts`:

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
): Promise<SessionNameGeneration>;

export function normalizeSessionName(value: string): string | undefined;
export function isUsableSessionTitle(value: string): boolean;
export function shortenSessionName(value: string): string;
export function cleanSessionName(value: string): string | undefined;
export function fallbackSessionName(firstMessage: unknown): string | undefined;
```

These are declaration contracts; the implementation supplies function bodies. `generateShortSessionName` has no fourth argument, default thinking level, or overload accepting a thinking level. Remove its obsolete `ThinkingLevel` import. An ordinary rejected completion returns the `ok: false` variant, never a bare `undefined` or an empty success title. A successful title is normalized, validated, and shortened.

The unchanged export remains:

```ts
export function deterministicSessionName(
  firstMessage: unknown,
): string | undefined;
```

The timeout, input limit, display limit, and fallback word-count constants remain module-private. No additional exported rejection type is necessary.

### Utility-fallback runner export

Keep the existing `UtilityModelIdentity`, `UtilityModelAttempt`, `UtilityModelResolver`, and `UtilityModelTask` types. In particular, an attempt still has `{ model: TModel; thinkingLevel: ThinkingLevel }`, identity still has `{ provider: string; id: string }`, and the task union remains `"lightweight" | "context"`.

Append a sixth optional positional parameter to the existing export in `utilityModelResolver.ts`; do not move or change the existing fifth `onFailure` parameter:

```ts
export async function runWithUtilityModelFallback<
  TModel extends UtilityModelIdentity,
  TResult,
>(
  resolver: UtilityModelResolver<TModel>,
  task: UtilityModelTask,
  activeAttempt: UtilityModelAttempt<TModel> | undefined,
  run: (
    attempt: UtilityModelAttempt<TModel>,
  ) => Promise<TResult | undefined> | TResult | undefined,
  onFailure?: (attempt: UtilityModelAttempt<TModel>, error: unknown) => void,
  normalizeAttempt?: (
    attempt: UtilityModelAttempt<TModel>,
  ) => UtilityModelAttempt<TModel>,
): Promise<TResult | undefined>;
```

The normalizer is synchronous and returns an attempt of the same model type. It is optional per runner invocation, not a resolver setting or a new configuration key. Callers that want normalization without exception diagnostics pass `undefined` in the fifth position. Existing callers that omit it retain their current behavior.

No service export changes. The naming methods retain their current private signatures:

```ts
private maybeGenerateSessionName(
  session: PiAgentSession,
  firstMessage: string,
): void;

private applyGeneratedSessionName(
  session: PiAgentSession,
  name: string | undefined,
): void;
```

## Title request contract

Each invocation of `generateShortSessionName` makes one call to the injected `streamFn`, using the supplied model, the existing `normalizeContext(context)` boundary, and exactly these title-specific options:

```ts
{
  reasoning: "off",
  maxTokens: 256,
  signal: AbortSignal.timeout(SESSION_NAME_TIMEOUT_MS),
}
```

`SESSION_NAME_TIMEOUT_MS` remains `10_000`. Every candidate, including an active-model retry, receives an explicit `reasoning: "off"`; omission is not equivalent. There is no configured-level forwarding and no change to the runtime's per-model handling of `off`. The 256-token value is a ceiling, not a requested title length.

Keep the current system prompt verbatim:

```text
Generate a concise title for a coding-agent chat session. Return only the title, with no quotes or punctuation wrapper.
```

Keep the single user message, its `Date.now()` timestamp, and its content:

```ts
`Create a 2-6 word title for this request:\n\n${truncateInput(firstMessage)}`
```

Input truncation remains the existing JavaScript string operation: at most the first 4,000 UTF-16 code units of the request, followed by `…` only when the original string is longer than 4,000. Thus 4,000 `x` characters are unchanged; 4,001 become `"x".repeat(4_000) + "…"`. The code-point requirement below applies to title display shortening, not this unchanged input truncation.

Keep authentication, headers, provider routing, rate limiting, retries inside the injected runtime, and timeout ownership unchanged. Do not add another model request, prompt variant, retry loop, or timer inside the generator.

## Ordered attempt acceptance and rejection

Consume the stream and remember the assistant message supplied by a `done` event. A stream's stored result or accumulated `text_delta` content cannot substitute for that event. Concatenate only the final message's `text` block values in content order, without an inserted separator, after checking the earlier conditions below. Ignore the values of `thinking` blocks when extracting title text.

Apply this ordered decision table. The first applicable rejection determines the result, including when later conditions would also fail:

| Order | Condition | Exact result |
| --- | --- | --- |
| 1 | The stream emits an `error` event. | `{ ok: false, reason: "stream-error" }` |
| 2 | Iteration ends without any `done` event. | `{ ok: false, reason: "no-completion" }` |
| 3 | The completed message's `stopReason` is anything other than `"stop"`. | `{ ok: false, reason: "incomplete-stop" }` |
| 4 | Any completed-message content block has a type other than `"text"` or `"thinking"`. | `{ ok: false, reason: "non-text-content" }` |
| 5 | `normalizeSessionName` of the concatenated text returns `undefined`. | `{ ok: false, reason: "empty" }` |
| 6 | `isUsableSessionTitle` returns `false` for that normalized, uncapped string. | `{ ok: false, reason: "unusable" }` |
| 7 | All preceding conditions pass. | `{ ok: true, title: shortenSessionName(normalized) }` |

An emitted stream error takes precedence over missing completion. For a completed message, use `message.stopReason`, not merely the `done` event's `reason` field. Reject `length`, `toolUse`, `deferred`, `aborted`, `error`, and `pending` through order 3, even if their text looks like a valid title. The exact comparison to `"stop"` also rejects any future non-answer terminal value.

A message with both `thinking` and `text` blocks is allowed: `thinking` is not itself a reason for rejection. Thinking-only and empty-content completions reach order 5 and return `empty`. A message containing a tool call is rejected at order 4 even if it also contains usable text. A completed message with `stopReason: "toolUse"` and a tool-call block returns `incomplete-stop`, before content validation. A `stop` completion containing blank text and a tool-call block returns `non-text-content`, before the blank-text check.

Do not convert thrown exceptions into the `stream-error` variant. An exception thrown by `streamFn` or stream iteration continues to reject the generator promise and is handled by the runner's existing `onFailure` path. Stream events and completed-message rejection are ordinary results; thrown failures remain exceptions.

## Normalization, validation, and display shortening

The three stages have separate responsibilities. Generated text follows normalize → validate uncapped text → shorten. The fallback path uses normalize → shorten, without generated-title validation.

### `normalizeSessionName`

Preserve the existing cleanup semantics while removing the display cap from this stage. Apply these operations in order:

1. Take only `(value.split("\n", 1)[0] ?? "")`. Do not search later lines for the first nonblank line.
2. Remove a leading label with `/^\s*(title|session title)\s*:\s*/i`.
3. Preserve the existing ASCII quote/backtick and trailing-period cleanup: replace ``/^\s*["'`]+|["'`.]+\s*$/g`` with the empty string. This removes runs of leading double quotes, single quotes, or backticks and trailing runs of those characters or periods, together with their adjacent edge whitespace. It does not introduce a general punctuation stripper.
4. Collapse JavaScript whitespace with `/\s+/g` to one ASCII space, then call `trim()`.
5. Return `undefined` if the result is empty; otherwise return the entire string, without a length cap or title-validation check.

Examples (quoted values use JavaScript string notation):

| Input | Output |
| --- | --- |
| `'Title: "Fix Session Naming."\nextra'` | `"Fix Session Naming"` |
| `"  Session title: 'Fix\t login   bug.'  "` | `"Fix login bug"` |
| `"Fix login bug\nWe need a title"` | `"Fix login bug"` |
| `" \nFix login bug"` | `undefined` |
| `'Title: ""'` | `undefined` |
| `"We need a session title"` | `"We need a session title"` (validation rejects it later) |
| `"x".repeat(61)` | The same 61-character string. |

### `isUsableSessionTitle`

This pure predicate receives normalized text before display shortening. It must neither shorten the argument nor apply `cleanSessionName` internally.

Return `false` for an empty or whitespace-only string. Count words as nonempty whitespace-separated tokens (`value.trim().split(/\s+/)` after the empty check); punctuation and hyphens within a token do not create extra words. A nonempty unspaced CJK string or identifier counts as one word. Accept one through eight words, subject to the remaining rules; do not impose a two-word minimum from the prompt.

Reject any case-insensitive occurrence of the following whole-word phrases. Match after normalization, so repeated spaces in the original response have already collapsed:

```ts
/\b(?:no quotes|punctuation wrapper|2-6 words?|the user wants|we need|need to (?:produce|infer|craft))\b/i
```

The `2-6 word` marker includes its plural `2-6 words` form. The hyphen here is the literal ASCII hyphen. Phrases can occur anywhere in the candidate, not only at the beginning.

Reject a final connector token from this exact case-insensitive set:

```text
and or for the a an to with of in on by
```

For this check, take the final whitespace-separated token and remove a trailing run of ASCII `.,!?;:` characters before comparing it to the set. Do not remove internal token characters or treat a substring of a longer word as a connector. For example, `"Fix login With,"` fails and `"Fix login within"` passes. This punctuation treatment makes the dangling-connector rule explicit without adding another rejection category.

Examples:

| Normalized input | Usable? | Reason |
| --- | --- | --- |
| `"Login"` | `true` | A legitimate one-word title is allowed. |
| `"Fix flaky article bridge FTS retry test"` | `true` | Seven words. |
| `"Fix flaky article bridge FTS retry test failures"` | `true` | Eight words. |
| `"Fix flaky article bridge FTS retry test failures today"` | `false` | Nine words. |
| `"The user wants login fixes"` | `false` | Reasoning echo. |
| `"Need to craft title"` | `false` | Reasoning echo. |
| `"Fix login with"` | `false` | Dangling connector. |
| `"Fix login With,"` | `false` | Dangling connector with punctuation. |
| `"x".repeat(61)` | `true` | A long single token is not rejected for length. |

The following fixture is mandatory to distinguish validation-before-shortening from validation-after-shortening:

```text
Investigate strange session naming behavior across providers before generating final answers
```

It has eleven words. Its first 60 characters are exactly `Investigate strange session naming behavior across providers`, a seven-word string that would pass validation. The full completion must return `{ ok: false, reason: "unusable" }`; it must never become that shortened title.

### `shortenSessionName`

This pure display helper receives prepared text and returns a string. It does not validate, normalize, or append an ellipsis. Its behavior is:

1. Measure and slice Unicode code points, using `Array.from(value)` or equivalent code-point iteration. Do not use a UTF-16 `slice(0, 60)` for this operation.
2. If the text has at most 60 code points, return it unchanged, including an empty string.
3. Otherwise find the last whitespace boundary at or before the 60-code-point cutoff. Precisely, find the greatest index `i` such that `0 < i <= 60` and code point `i` is whitespace. Cut before that whitespace. A space immediately following the first 60 code points is a usable boundary and preserves all 60 preceding code points.
4. If no such boundary exists, return exactly the first 60 code points, even if this cuts a single token, URL, or unspaced CJK value.
5. Trim trailing whitespace from the cut result. Do not introduce an additional punctuation-removal rule when shortening; punctuation adjacent to the cut is preserved.

Never revalidate the shortened result. A valid full title can shorten to a prefix that ends in a connector; shortening is solely a display operation.

| Input | Exact output |
| --- | --- |
| `"Improve authentication reliability across distributed production environments"` | `"Improve authentication reliability across distributed"` |
| `"Investigate strange session naming behavior across providers globally"` | `"Investigate strange session naming behavior across providers"` (exactly 60 code points) |
| `"x".repeat(61)` | `"x".repeat(60)` |
| `"界".repeat(61)` | `"界".repeat(60)` |
| `"𠮷".repeat(61)` | `"𠮷".repeat(60)` (60 code points, 120 UTF-16 code units) |
| `"x".repeat(61) + " suffix"` | `"x".repeat(60)`; a later whitespace boundary cannot extend the cap. |
| `""` | `""` |

### `cleanSessionName`

Keep this export as the convenience operation for non-generated names:

```ts
const normalized = normalizeSessionName(value);
return normalized === undefined ? undefined : shortenSessionName(normalized);
```

It does not call `isUsableSessionTitle`. Thus `cleanSessionName("We need title")` returns `"We need title"`; generated text with that value is rejected by the generator's separate validation stage.

## Deterministic fallback contract

`fallbackSessionName` accepts `unknown` and returns `undefined` for every non-string input. For strings, preserve the existing skill-block removal, fenced-code removal, Markdown-character cleanup, six-word slice, and final `cleanSessionName` boundary. Add scaffold stripping before word slicing, while line boundaries are still available.

The exact processing order is:

1. Remove skill blocks using the existing `/<skill name="[^"]+" location="[^"]+">[\s\S]*?<\/skill>/g`, replacing matches with `""`.
2. Remove complete triple-backtick fenced blocks using the existing `/```[\s\S]*?```/g`, replacing matches with `" "`.
3. Trim leading whitespace. Strip one leading `PM:` or `Project manager:` marker, case-insensitively, with `/^(?:PM|Project manager)\s*:\s*/i`. This can leave the request on the same line or expose following metadata lines.
4. Trim leading whitespace and remove leading metadata lines, repeatedly, while the next line matches `/^(?:Model tier|Role)\s*:[^\r\n]*(?:\r?\n|$)/i`. Remove each entire matching line, including its value; trim leading whitespace between removals. Support LF and CRLF line endings and blank lines between leading scaffolding lines. Metadata occurring after substantive request text is retained.
5. Strip one leading role-introduction prefix with `/^You\s+are\s+(?:the|an|a)\b\s*/i`. Remove only `You are` and its article. Keep the role description and the rest of the sentence: the approved example explicitly retains `deterministic SDD lane runner ...`.
6. Preserve the current replacement of each backtick, asterisk, underscore, hash, square bracket, parenthesis, brace, and angle bracket with a space: ``/[`*_#[\](){}<>]/g``.
7. Split on whitespace, discard empty tokens, keep the first six tokens, and join with one ASCII space.
8. Return `cleanSessionName` of that joined string.

Do not run the generated-title word-count, echo, or connector predicate on fallback text. A fallback can legitimately end in `the` or contain a phrase such as `we need`, because it is extracted from the user's own request. The six-word slice occurs before normalization and display shortening, as in the current implementation.

Exact examples:

| First request | `fallbackSessionName` result |
| --- | --- |
| `"PM: Bug: Utility models for session naming doesn't work"` | `"Bug: Utility models for session naming"` |
| `"Project manager: Fix the flaky login retry tests"` | `"Fix the flaky login retry tests"` |
| `"You are the deterministic SDD lane runner for the f-worker lane of appio."` | `"deterministic SDD lane runner for the"` |
| `"Model tier: Worker\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio."` | `"deterministic SDD lane runner for the"` |
| `"PM:\nModel tier: Worker\n\nRole: Implementer\nYou are the deterministic SDD lane runner for the f-worker lane of appio."` | `"deterministic SDD lane runner for the"` |
| `"You are an expert debugger for login failures"` | `"expert debugger for login failures"` |
| `"You are a coding assistant fixing login failures"` | `"coding assistant fixing login failures"` |
| `"Seems like auto name for sessions is not working, I still get the first message as a name."` | `"Seems like auto name for sessions"` |
| `'<skill name="x" location="/x">\nDo x\n</skill>\n\nCheck the UI now'` | `"Check the UI now"` |
| `"Investigate failures\nRole: reviewer"` | `"Investigate failures Role: reviewer"` |
| `"```ts\nconst value = 1;\n```"` | `undefined` |
| `"PM:"` | `undefined` |
| `"Project manager:"` | `undefined` |
| `"Model tier: Worker\nRole: Implementer"` | `undefined` |
| `undefined` | `undefined` |

Marker-only, metadata-only, skill-only, code-only, or otherwise empty cleaned input is a declared empty outcome. Do not invent a placeholder name, rescue text from a removed block, or use a rejected model response as a fallback.

### Relay-handoff precedence

Keep `deterministicSessionName` and the relay recognition/formatting helpers unchanged. The service invokes it before resolving utility candidates or checking for a session model. The existing canonical first-line format remains `Relay "<name>" leg <number> begins now.`; unrelated mentions of a relay do not match.

Preserve these exact existing results:

```text
Relay "handoff-check" leg 2 begins now.\n\nYou are the next runner.
→ Relay handoff-check leg 2

Relay "very-long-relay-name-that-would-otherwise-push-the-leg-number-out-of-view" leg 42 begins now.
→ Relay very-long-relay-name-that-would-otherwise-push leg 42
```

`deterministicSessionName('You are continuing Relay "handoff-check" under the Relay method.')` remains `undefined`. Do not make `fallbackSessionName` itself call the relay recognizer or change the relay-specific truncation algorithm as part of the code-point display change.

## Attempt normalization and deduplication

`runWithUtilityModelFallback` still obtains configured candidates once, preserves their order, and appends the active attempt when present. For each raw candidate, including the appended active attempt:

1. Apply `normalizeAttempt` if supplied; otherwise retain the original attempt.
2. Compute the existing identity key from that resulting attempt:

   ```ts
   JSON.stringify([
     attempt.model.provider,
     attempt.model.id,
     attempt.thinkingLevel,
   ])
   ```

3. Keep only the first occurrence of each key.
4. Pass the kept, normalized attempt to `run` and, if `run` throws, to `onFailure`.

Normalization must happen before both identity computation and storing the attempt for execution. Apply it once per raw candidate, including candidates later discarded as duplicates. Do not mutate the resolver's returned objects, the active attempt, model objects, or persisted settings. The title normalizer returns a fresh attempt such as `{ ...attempt, thinkingLevel: "off" }`.

The runner still executes retained attempts sequentially, returns the first result other than `undefined`, advances on `undefined` or a caught attempt exception, and returns `undefined` after exhaustion. Omitting the normalizer preserves identity by `(provider, id, thinkingLevel)` and all current exception behavior. Do not globally change `attemptKey`, utility resolution, or slot eligibility to ignore thinking levels.

Title generation passes the normalizer that forces `off`. Consequently its effective identity is `(provider, id)`: a configured lightweight model at `high` and the same active fallback model at `minimal` collapse into one request at `off`, even if represented by different model objects. Models with different providers or IDs remain distinct. The first configured instance wins.

This ordering prevents duplicate byte-equivalent title requests and duplicate sequential timeout windows. Normalizing only in `run`, or computing a raw key before normalization, still allows two calls after the first rejection and violates the contract. A success-only fixture cannot prove deduplication because the runner would stop after its first success even with two stored candidates.

## Service integration and lifecycle

### `maybeGenerateSessionName`

Preserve the current entry guards, in their current role: return when the session already has a name, has any messages, is streaming, or is compacting. Preserve scheduling and the existing prompt lifecycle; do not introduce a second naming scheduler, retry flag, or change model-policy checks.

After those guards:

1. Try `deterministicSessionName(firstMessage)` and apply a defined relay name immediately through `applyGeneratedSessionName`, then return.
2. Capture `const model = session.model` once. If it is `undefined`, return before utility resolution, model calls, or `fallbackSessionName`. Keep the existing narrowed-model snapshot behavior across asynchronous work.
3. Invoke `runWithUtilityModelFallback` for `"lightweight"`, retaining the active attempt shape `{ model, thinkingLevel: "minimal" }` and supplying the new sixth-argument title normalizer that forces `off`.
4. In the asynchronous `run` callback, call `generateShortSessionName(session.agent.streamFunction, attempt.model, firstMessage)` with three arguments.
5. For `ok: true`, return that accepted result to the runner. For `ok: false`, emit the rejection log below and return `undefined`, allowing the runner to try its next distinct candidate.
6. On settlement, call `applyGeneratedSessionName(session, result?.title ?? fallbackSessionName(firstMessage))`.
7. Retain the existing outer `.catch` for asynchronous naming/application bookkeeping failures.

The rejection diagnostic is one `info` call per actually executed rejected attempt, including the last attempt before deterministic fallback. Its exact fields and message are:

```ts
this.logger.info(
  {
    provider: attempt.model.provider,
    modelId: attempt.model.id,
    reason: result.reason,
  },
  "utility title model rejected",
);
```

Do not add raw prompt text, rejected text, thinking text, `thinkingLevel`, or an `error` field to this ordinary-rejection record. Do not throw an ordinary rejection or route it through `onFailure`.

Keep the existing thrown-exception log, with the normalized attempt's level, in the fifth-argument hook:

```ts
this.logger.info(
  {
    provider: attempt.model.provider,
    modelId: attempt.model.id,
    thinkingLevel: attempt.thinkingLevel,
    error: error instanceof Error ? error.message : String(error),
  },
  "utility title model failed",
);
```

For title attempts that level is now `"off"`. The existing outer failure diagnostic remains `{ sessionId: session.sessionId, error: <stringified error> }` with message `"failed to apply generated session name"`.

### `applyGeneratedSessionName`

Keep this method's behavior and guard ordering unchanged:

1. A missing name or a session that already has a name is a no-op.
2. A session that is no longer the current active session is a no-op. A late title must not recreate an archived/deleted transcript or name an obsolete runtime after reload or replacement.
3. While that session is in `treeNavigations`, save the candidate in `deferredGeneratedSessionNames` and return without writing a name.
4. Otherwise call `session.setSessionName(name)` and the existing `publishSessionName(session)` path.

Keep deferred-tree-work flushing and its error containment unchanged. It re-enters the same guarded application path after navigation and discards work for a session that ceased to be current. Existing names set while generation was pending continue to win. Preserve existing message/busy/name guards against repeated first-prompt naming.

No-model and empty-fallback outcomes write no name and publish no `session.name` event. The session-list fallback display does not change. Naming continues to be an out-of-band operation and must not change the active model, active thinking level, model defaults, or prompt delivery.

## Test strategy and concrete Vitest matrix

Use the existing Vitest files and file-local fakes. Do not call a live provider or introduce a new harness package or test helper file. Use `createAssistantMessageEventStream` for stream fixtures. Extend the existing `fakeAssistantMessage`, `completedTitleStream`, `failedTitleStream`, `titleAssistantMessage`, `utilityResolverFor`, and deferred-stream patterns as needed.

For successful and completed-rejection fixtures, explicitly push a `done` event and end the stream. For `stream-error`, push an `error` event. For `no-completion`, emit a valid-looking `text_delta`, then end the stream with a stored assistant message via `stream.end(message)` **without** pushing a `done` event, so an implementation that trusts the stored end result or the accumulated deltas still fails the case. A stored end result alone is not completion. Construct intentionally unknown content or unusual terminal states at one documented fixture boundary if the SDK's narrower event type requires a cast; keep the rest of the fixtures strictly typed.

The case names below describe concrete `it` cases; parameterized rows may use `it.each`. Assert the complete discriminated result with `toEqual`, including rejection reasons. Do not retain old string/`undefined` expectations for the generator or the old fourth-argument thinking-level calls.

### `src/server/sessions/sessionNameGenerator.test.ts`

Request and completed-result cases:

| Vitest case | Fixture and required assertions |
| --- | --- |
| `generates a normalized title with reasoning off and a 256-token ceiling` | Complete with `'Title: "Fix the bug"'`. Expect `{ ok: true, title: "Fix the bug" }`, one call, supplied model, and options containing explicit `reasoning: "off"` and `maxTokens: 256`. Replace the old `minimal`, explicit-`max`, and omitted-`off` request tests. |
| `keeps the title timeout and input truncation unchanged` | Observe `AbortSignal.timeout(10_000)` through a restored spy and assert that its signal is passed to the stream. Assert the exact system/user prompts above, and assert that the single user message's `timestamp` equals the value captured from a `Date.now()` spy. Parameterize 4,000 and 4,001 `x` characters: the user suffix is respectively 4,000 `x` characters and 4,000 plus `…`. Add 2,001 `𠮷` code points (4,002 UTF-16 code units): the suffix must be exactly 2,000 complete code points followed by `…`, never 2,001 code points and never a dangling surrogate half. |
| `uses final text blocks instead of partial deltas or thinking text` | Supply a misleading `text_delta`, then a `stop` final message with adjacent text blocks `"Fix"` and `"login bug"`. Expect `{ ok: true, title: "Fixlogin bug" }`. The adjacent blocks prove concatenation inserts no separator; a space-inserting implementation would produce `"Fix login bug"` and fail. |
| `accepts thinking plus a usable text title` | A `stop` completion has `{ type: "thinking", thinking: "We need a session title" }` followed by `{ type: "text", text: "Fix login bug" }`. Expect `{ ok: true, title: "Fix login bug" }`. A reject-all-thinking implementation must fail this positive case. |
| `rejects a length-limited completion` | A `done` message has `stopReason: "length"` and text `"Fix login bug"`. Expect `{ ok: false, reason: "incomplete-stop" }`. |
| `rejects non-answer terminal reason %s` | `it.each(["toolUse", "deferred", "aborted", "error", "pending"] as const)`: complete each message with otherwise valid text while keeping the `done` event's `reason` as `"stop"` and setting only `message.stopReason` to the parameterized value. Expect `incomplete-stop` for every value. Add the converse control: `message.stopReason: "stop"` with a non-stop `done.reason` must be **accepted**, proving the message field is authoritative. Do not replace these with an error-event fixture. |
| `rejects non-text content type %s` | Parameterize a tool-call block `{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }` and an intentionally unknown block type such as `"unknown"`. Include usable text and `stopReason: "stop"`; expect `non-text-content` in both cases. |
| `rejects a stream that ends without done despite text deltas` | Emit a valid-looking `"Fix login bug"` delta and end without a `done` event. Expect `{ ok: false, reason: "no-completion" }`. |
| `classifies an emitted stream error directly` | Use the existing error-event pattern; expect `{ ok: false, reason: "stream-error" }`, not `no-completion` and not a thrown exception. |
| `classifies blank and thinking-only completions as empty` | Parameterize empty content, whitespace-only text, `'Title: ""'`, and thinking-only content, all completed with `stop`. Expect `{ ok: false, reason: "empty" }`. |
| `checks stop reason before tool content` | A `toolUse` completion also contains a tool-call block and valid text. Expect `incomplete-stop`. |
| `checks content types before empty text` | A `stop` completion contains a tool call and whitespace-only text. Expect `non-text-content`. |
| `validates the entire title before shortening` | Complete with the eleven-word `Investigate strange ... final answers` fixture above. Assert the full value has eleven tokens and its first 60 characters equal the specified seven-word string, then expect `{ ok: false, reason: "unusable" }`. |
| `rejects reasoning echo %s` | Parameterize `"No quotes please"`, `"Remove punctuation wrapper"`, `"Create a 2-6 word title"`, `"Create a 2-6 words title"`, `"The user wants login fixes"`, `"We need a session title"`, `"Need to produce title"`, `"Need to infer title"`, `"Need to craft title"`, and `"Fix login because we need retries"`. Expect `unusable` for each. |
| `accepts a legitimate %s-word title` | Parameterize `"Login"`, the seven-word `"Fix flaky article bridge FTS retry test"`, and the eight-word version ending `"test failures"`. Expect exact successful titles. |
| `rejects a nine-word title` | Complete with `"Fix flaky article bridge FTS retry test failures today"`; expect `unusable`. |
| `rejects dangling connector %s` | Parameterize all twelve connector words in `"Fix login ${connector}"`, plus `"Fix login With,"`. Expect `unusable` for each. Include `"Fix login within"` as a successful boundary control. |
| `shortens only after accepting a long legitimate title` | Complete with `"Improve authentication reliability across distributed production environments"`. Expect `{ ok: true, title: "Improve authentication reliability across distributed" }`. |
| `never revalidates the shortened display value` | Complete with the eight-word valid title `Investigate authentication failures across providers and document recovery`. It passes uncapped validation, and shortening cuts it to `Investigate authentication failures across providers and`, which ends in the connector `and` and would fail validation. Expect `{ ok: true, title: "Investigate authentication failures across providers and" }`; an implementation that revalidates after shortening returns `unusable` and fails. |
| `accepts and caps a long unspaced title` | Parameterize `"x".repeat(61)` and `"𠮷".repeat(61)` as completed text. Expect success with the corresponding 60-code-point prefix; assert code-point length explicitly. |
| `lets a thrown stream factory failure reach the caller` | Make the injected `streamFn` itself throw a specific `Error`; expect the generator promise to reject with that same error. An implementation that wraps the factory call and returns `stream-error` fails. |
| `lets a thrown stream iteration failure reach the caller` | Return a stream that yields one `text_delta` and then throws a specific `Error` from its iterator; expect the generator promise to reject with that same error rather than returning `{ ok: false, reason: "stream-error" }`. This is the fixture that punishes converting iteration exceptions into ordinary rejections. |

Pure-helper cases in the same file:

| Vitest case | Fixture and required assertions |
| --- | --- |
| `normalizes labels quotes whitespace and the first line` | Parameterize every normalization example above and assert its exact result. Include a value longer than 60 to prove normalization itself is uncapped. |
| `validates uncapped title structure` | Directly assert `isUsableSessionTitle` for blank input, the one/seven/eight/nine-word fixtures, echo cases, connectors, and long single tokens. These assertions complement the generator cases rather than replacing them. |
| `shortens at a word boundary` | Assert the exact `Improve authentication ...` result above. |
| `preserves punctuation adjacent to the shortening cut` | Assert `shortenSessionName("x".repeat(59) + "! suffix") === "x".repeat(59) + "!"`. A shortening implementation that strips punctuation at the cut fails. |
| `preserves a full sixty-code-point prefix ending at a boundary` | Use the eight-word `Investigate strange ... globally` value and expect the exact 60-code-point result above. |
| `caps an unspaced value at sixty code points` | Parameterize `"x"`, `"界"`, and `"𠮷"` repeated 61 times; expect the corresponding 60 repetitions. Include `"x".repeat(61) + " suffix"`. Assert supplementary CJK remains intact, not 30 characters or a dangling surrogate. |
| `leaves a short display string unchanged` | Assert `shortenSessionName("") === ""` and an existing short title is unchanged. |
| `keeps cleanSessionName as normalization plus shortening` | Preserve `'Title: "Fix Session Naming."\nextra' → "Fix Session Naming"`; add `"We need title" → "We need title"` and the long legitimate title's boundary-cut result. |
| `strips a leading PM or project-manager marker from a fallback` | Parameterize both marker examples above, plus case/whitespace variants with the same exact outputs. |
| `strips leading tier and role metadata before the fallback slice` | Use both combined metadata/role examples above, plus their CRLF form; expect `"deterministic SDD lane runner for the"`. |
| `removes only the leading role introduction` | Parameterize the `the`, `an`, and `a` examples above with their exact results. |
| `keeps metadata after substantive request text` | `"Investigate failures\nRole: reviewer" → "Investigate failures Role: reviewer"`. |
| `preserves existing first-request and skill-block fallbacks` | Preserve `"Seems like auto name for sessions"` and `"Check the UI now"` from the existing fixtures. |
| `returns no fallback for empty cleaned request %s` | Parameterize the code-only, `PM:`, `Project manager:`, metadata-only, skill-only, and whitespace-only requests. Expect `undefined`; retain the non-string/missing-request case. |
| `normalizes and shortens fallback text without model-title validation` | The scaffold example ending `"for the"` remains defined. A fallback from `"We need a session title"` remains that exact string. A 61-character single-token request returns its 60-code-point prefix. |
| `preserves deterministic relay recognition and leg formatting` | Keep all three existing relay cases and the exact results in the relay section. |

### `src/server/sessions/piSessionService.promptQueue.test.ts`

Keep the existing `fakeRuntime`/`runtimeCreator` service setup, injected `utilityResolverFor`, `CapturingSessionEventHub`, deferred title streams, and service disposal. Assert applied names and name events, stream-call identity/order/options, and diagnostics at these boundaries. Wait for asynchronous naming to settle before asserting a negative name/event outcome; an immediate `toBeUndefined()` alone is not evidence that the fallback chain completed.

| Vitest case | Fixture and required assertions |
| --- | --- |
| `uses the configured lightweight model with thinking off without changing active title state` | Adapt the existing configured-`high` success case. Expect only the lightweight model, `{ reasoning: "off", maxTokens: 256 }`, name `"Fix login bug"`, and its name event. Preserve active model/thinking state and the no-`setModel`/no-`setThinkingLevel` assertions. |
| `falls back from a rejected lightweight title to the active model with thinking off` | Lightweight and active models differ. The first completed title has `stopReason: "length"`; the active completion is `"Active model title"` with `stop`. Expect those two models in order, reasoning `["off", "off"]`, both budgets 256, and the active title applied. |
| `keeps stream-error fallback to a distinct active model` | Preserve the existing failed-stream-to-active route, now classifying its error event as an ordinary `stream-error` rejection. Both requests use `off`; the active title is applied. |
| `logs every rejected title attempt including the last before fallback` | For the PM request above, a distinct lightweight completion rejects as `incomplete-stop` and the active completion `"We need a session title"` rejects as `unusable`. After fallback settlement, assert exactly two `"utility title model rejected"` entries, in attempt order, each with exactly `{ provider, modelId, reason }`. Assert the final applied name is `"Bug: Utility models for session naming"` and no ordinary rejection is logged as `"utility title model failed"`. |
| `deduplicates a same-model title fallback with the same thinking level` | Preserve the existing same-model success fixture, changing its request assertion from `minimal` to `off` and adding the 256-token ceiling. Expect one call and `"Shared title"`. |
| `deduplicates a rejecting same-model title fallback across thinking levels` | Replace the current different-level/two-call fixture as specified below. Expect exactly one rejected request at `off`, followed by the exact first-request fallback. |
| `accepts one same-model title attempt across thinking levels` | Companion positive case: configured candidate is the active model at `high`; active fallback is `minimal`; the first completion is `"Shared title"`. Expect one request at `off`, 256 tokens, and that generated title. |
| `applies the exact cleaned fallback when all distinct models reject` | Make lightweight and active attempts both reject for the PM request. Expect two calls, two rejection logs, the exact name `"Bug: Utility models for session naming"`, and the normal name publication. This may share the concrete fixture with the diagnostic case if every assertion remains present. |
| `stays unnamed when every attempt rejects and the fallback is empty for %s` | Parameterize code-only `"```ts\nconst value = 1;\n```"`, marker-only `"PM:"`, and metadata-only `"Model tier: Worker\nRole: Implementer"`. Await both distinct rejected attempts and naming settlement. Expect no `setSessionName`, `sessionName` still `undefined`, and no `session.name` event. |
| `does not attempt naming without a resolved session model` | Exercise the existing naming boundary with `session.model === undefined` and an otherwise eligible unnamed session. Expect no resolver call, no stream call, no name write/event, and no first-message fallback despite usable first-message text. See the boundary setup below. |
| `uses only the active model when no utility candidate is configured` | Preserve the existing active-only success case, asserting explicit `off` and 256 tokens. |
| `uses the narrowed active-model snapshot for first-prompt title fallback` | Preserve the existing changing-getter fixture and successful `"Snapshot model title"`. The captured model must be used rather than rereading `session.model` for the active attempt. |
| `logs thrown attempt failures through the existing exception hook` | A distinct utility model throws `Error("utility title failed")`; active succeeds. Assert one `"utility title model failed"` log with the existing fields, `thinkingLevel: "off"`, and `error: "utility title failed"`; the thrown attempt is not also logged as an ordinary rejection. |
| `contains and logs failures from asynchronous title bookkeeping` | Retain the existing throwing-`setSessionName` case and exact `{ sessionId, error }`/`"failed to apply generated session name"` assertion. |
| `preserves late-title lifecycle and relay behavior` | Retain the active late-title success, archived-session no-write, and deterministic relay-without-resolver/stream cases. Retain existing tree-navigation deferral coverage; do not bypass the guarded application path for any new result variant. |

All four existing reasoning assertion sites that encode configured levels must change: the first configured-title assertion currently using `"high"`, the two-attempt array `["high", "minimal"]`, the same-level success assertion currently using `"minimal"`, and the different-level fixture's array `["high", "minimal"]`. Every title attempt now asserts `"off"`; utility level configuration and non-title assertions stay unchanged.

#### Discriminating same-model rejection fixture

Keep the configured candidate at `high` and the active attempt at its existing `minimal` fallback level. Make the fake stream deliberately succeed if a duplicate request is issued:

```ts
let attempts = 0;
const streamFn = vi.fn<StreamFn>((streamModel) => {
  attempts += 1;
  return attempts === 1
    ? failedTitleStream(streamModel.id)
    : completedTitleStream(streamModel.id, "Unexpected duplicate title");
});
```

Use the same model for configured and active identities, `utilityResolverFor([utilityCandidate(activeModel, "high")])`, and first request `"Please fix the login bug"`. After the chain settles, assert:

```ts
expect(streamFn).toHaveBeenCalledOnce();
expect(streamFn.mock.calls[0]?.[0]).toBe(activeModel);
expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
  reasoning: "off",
  maxTokens: 256,
});
expect(fake.session.sessionName).toBe("Please fix the login bug");
```

Also assert one rejection diagnostic with `reason: "stream-error"`. Without the normalizer, or with normalization after the key calculation, a second request would succeed and apply `"Unexpected duplicate title"`. Both the call-count and name assertions therefore discriminate the required ordering. Do not change this fixture into an always-successful or always-failing stream; those weaken its proof.

#### No-model boundary setup

The public `prompt` path performs existing model-policy validation before naming. This specification preserves that validation; it does not require making a public prompt with no model newly valid.

For this one regression, initialize/register a fake runtime through the existing service harness while it has its normal model, then set the fake session's model to `undefined` and invoke the narrow private naming boundary with TypeScript's bracket access:

```ts
service["maybeGenerateSessionName"](fake.session, "Please fix the login bug");
```

Assert the no-model outcomes in the matrix. This avoids a read-count-dependent public-prompt fixture or a new exported production seam. A companion invocation with a canonical relay request and no model must still apply the deterministic relay name without resolving or calling a model, proving the relay check precedes the early return. Restore fixture state as needed for disposal.

### `src/server/sessions/utilityModelResolver.test.ts`

Although the main naming regressions live in the two files above, the approved design also requires the existing resolver-level compatibility proof here.

| Vitest case | Fixture and required assertions |
| --- | --- |
| `keeps same-model attempts with different levels and advances after failures` | Preserve the existing omitted-normalizer test: configured `acme/small/off` throws, `acme/large/xhigh` returns `undefined`, and active `acme/small/minimal` succeeds. Expect all three in order, the existing one exception callback, and unchanged frozen inputs. This pins level-distinct behavior for callers that omit the seam. |
| `deduplicates an active attempt with the configured model and level` | Preserve the existing omitted-seam test with a runner returning `undefined`, one call, and first configured-instance precedence. |
| `normalizes every candidate before identity and execution` | Freeze a configured `acme/small/high` attempt and an active `acme/small/minimal` attempt represented by separate model objects with the same provider/ID. Pass a spy normalizer returning a fresh spread with `thinkingLevel: "off"`; make `run` return `undefined`. Expect the normalizer to receive both raw attempts, exactly one `run` with the first normalized attempt at `off`, and unchanged inputs. Use `undefined` in the fifth position to exercise the optional-hook call shape. |
| `passes normalized attempts to exception diagnostics and preserves distinct identities` | Add distinct-provider/same-ID and same-provider/different-ID controls, all normalized to `off`. Make the first kept `run` throw, another return `undefined`, and the last succeed. Expect distinct normalized attempts in original order and `onFailure` receiving the normalized throwing attempt. |

Do not replace the omitted-seam compatibility fixture with a normalized one; both contracts must remain tested.

### Scope-boundary regression (unchanged suites)

The seam is opt-in, so the non-title utility consumers must keep their configured thinking levels without edits. Include these existing suites in the acceptance run and require them to pass unchanged:

| Vitest case | Fixture and required assertions |
| --- | --- |
| `retains configured thinking levels for branch summaries and compaction` | `src/server/sessions/utilityModelExtension.test.ts` keeps asserting that branch-summary and compaction handlers forward `candidate.thinkingLevel`, including the omitted-level passthrough case. No fixture in that file is modified by this change. |
| `retains suppressed reasoning for transcript polishing` | `src/server/speechInput/speechInputPolishingService.test.ts` keeps asserting the `off` clamp, including the reasoning-mandatory clamp and per-candidate fallback cases. No fixture in that file is modified by this change. |

A change that forwards `off` from the shared resolver, or that normalizes unconditionally inside it, is detected by the resolver tests above, not by these consumer suites: the consumers inject resolver fakes with prepared candidates and iterate them directly, so they never exercise the shared runner. Each suite therefore detects a different regression, and all of them must pass unchanged:

| Regression | Detected by |
| --- | --- |
| Unconditional normalization or forced `off` inside `runWithUtilityModelFallback` | `utilityModelResolver.test.ts`: the omitted-seam level-distinct and same-model/level fixtures |
| A consumer that stops forwarding `candidate.thinkingLevel` for branch summaries or compaction | `utilityModelExtension.test.ts` |
| Polishing that stops clamping to `off` | `speechInputPolishingService.test.ts` |

## Error handling and unchanged behavior

- Ordinary stream-error events, missing completions, non-answer stops, invalid block types, blank text, and unusable titles return the declared rejection union. They advance the resolver by the service returning `undefined` after its diagnostic.
- Thrown attempt exceptions retain the existing resolver catch and `onFailure` path. Resolution or application bookkeeping failures retain existing outer handling. No new provider-specific error parser or retry policy is introduced.
- Utility candidate resolution, configured-level eligibility checks, refresh behavior, slot ordering, and the active fallback's position remain unchanged. Only title invocations opt into pre-deduplication normalization.
- Branch summaries and compaction continue forwarding their configured utility thinking levels. Context-slot behavior is unchanged. Transcript polishing already clamps its attempts to `off`; that existing behavior is not part of this fix.
- Existing relay formatting and precedence, six-word fallback extraction, session-list first-message display, late-write protection, tree-navigation deferral, and active model/thinking state remain intact.
- The title timeout stays 10 seconds per distinct retained attempt, and input truncation stays 4,000 UTF-16 code units plus an ellipsis when needed. Deduplicating identical title requests intentionally removes redundant timeout windows.

## Non-goals

- Changing the one-api proxy, upstream Pi, model behavior, authentication, or transport.
- Changing which configured models resolve for lightweight or context utility slots.
- Changing branch-summary, compaction, or transcript-polishing prompts, budgets, or thinking behavior.
- Adding a config key, API field, route, UI control, naming scheduler, or semantic classifier.
- Renaming existing sessions, retrying naming for an already named session, or migrating stored session names.
- Providing a first-message fallback for sessions whose naming boundary has no resolved model.
- Changing prompt-model-policy authorization or introducing a new public testing seam for the no-model case.

## Changeset and implementation acceptance

The implemented fix requires one `.changeset/*.md` fragment with a `patch` bump for `@hyperdreamer/pi-webui`. For example:

```md
---
"@hyperdreamer/pi-webui": patch
---

Fix automatic session titles by rejecting incomplete or unusable model output and cleaning fallback names.
```

Do not manually edit `CHANGELOG.md`, bump package versions, or publish as part of implementation. This specification-only drafting task creates no Changeset; the fragment belongs with the production fix.

After implementation, run the focused files, then type checking, then routine broad verification:

```sh
npm test -- --run src/server/sessions/sessionNameGenerator.test.ts src/server/sessions/piSessionService.promptQueue.test.ts src/server/sessions/utilityModelResolver.test.ts
npm run typecheck
npm run verify:fast
```

These are future implementation acceptance checks, not checks to run while drafting this specification. Completion requires exact results and diagnostics from the matrix, the rejection-path deduplication proof, the positive thinking-plus-text case, and the omitted-normalizer compatibility case.

The eventual implementation changes session-daemon-loaded code. Its handoff must tell the operator that a manual restart of `pi-webui-sessiond.service` is needed for the new naming behavior to take effect; UI/API autoreload alone does not reload that runtime code.

## Clarifications made concrete

The approved design fixes the behavior; this specification resolves its remaining mechanical choices as follows:

- Add `normalizeAttempt` as the sixth optional positional argument, preserving the fifth exception hook and all omitted-seam consumers.
- Preserve existing ASCII quote/backtick and trailing-period normalization, first-line selection, and existing block/Markdown stripping rather than expanding cleanup into a general text parser.
- Make echo matching case-insensitive with whole-word phrase boundaries and a plural `words` alternative; check final connectors after stripping only trailing ASCII `.,!?;:` from the last token.
- Interpret a whitespace boundary exactly at the 60-code-point cutoff as usable, preserve punctuation on the retained prefix, and fall back to a 60-code-point prefix when no earlier boundary exists.
- Interpret the leading `You are (the|an|a)` clause as removal of that introduction only, as required by the design's retained-role example; process markers, repeated leading metadata lines, and that introduction in the stated order.
- Use `"utility title model rejected"` as the ordinary-rejection log message, with exactly the design's three diagnostic fields.
- Pin the no-model early return directly at the naming boundary because the public prompt path has separate existing model-policy prerequisites; those prerequisites remain unchanged.
