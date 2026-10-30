# Utility-Model Session Naming Design

**Date:** 2026-10-30
**Status:** approved design, awaiting implementation plan

## Background

Automatic session titles are wrong for a large share of new sessions. Two failure
shapes are visible in the session store:

- a 60-character chain-of-thought fragment such as
  `We need answer only title 2-6 words. Need concise. Request a`, and
- a 6-word slice of the first request such as `You are the SDD lane runner`.

Of 290 sessions named since 2026-10-26, 18 (6%) are truncated reasoning fragments,
50 (17%) are 6-word first-message fallbacks, and 222 read as real titles. Of the 50
fallback names, 42 begin with prompt scaffolding (`You are the…`, `Model tier: …`,
`Role: …`).

Live provider probes reproduce the defect with the exact call the code makes
(`maxTokens: 24` plus the configured utility thinking level):

| model (route) | cap | result |
| --- | --- | --- |
| `fallback/deepseek-v4.1-flash-1017` (configured lightweight, medium) | 24 | empty text — all 24 output tokens were reasoning |
| same, reasoning disabled | 24 | completed in 6 tokens: `Utility Session Naming Bug Check` |
| same | 128 | real title after 96 reasoning tokens |
| `New-API/deepseek-flash` (active-model retry, minimal/off) | 24 | text **is** the reasoning: `We need answer only title 2-6 words…` |
| `New-API/deepseek-flash` | 96 | real title; reasoning stays in its own channel |

`New-API/deepseek-flash` runs through a local one-api proxy that ignores
`reasoning.effort` and, when the completion is truncated by `max_output_tokens`,
exposes the partial reasoning as `output_text`.

Root cause chain:

1. `generateShortSessionName` requests `maxTokens: 24`, which a reasoning model
   spends entirely on reasoning, producing no visible text.
2. Truncated completions are accepted: the terminal `stopReason` is never checked.
3. When the configured slot yields nothing, `runWithUtilityModelFallback` retries on
   the active session model; for an always-thinking model the truncated text is
   reasoning, and it becomes the title.
4. Nothing validates the candidate title, and nothing is logged, so the failure is
   silent.

## Goal

A session whose title generation runs and whose first request yields usable text ends
up with either a genuine generated title or a recognisable deterministic title derived
from that request. When no usable name can be produced — every attempt rejected and the
request cleaning to nothing — the session stays unnamed, as declared below. The observed
reasoning-fragment shapes (`We need answer only title 2-6 words…`, `The user wants a
title…`) must never become a session name on any routing path that has a session model
and a generated completion.

Scope boundary: title generation requires a resolved session model. A session created
without a model keeps today's behaviour — the deterministic relay-handoff name still
applies because it runs before the model check, but no model call and no
first-message fallback name is attempted. Such a session stays unnamed and the list
shows its first message. This is declared, not accidental, and is pinned by a test.

The rules below are structural heuristics over format, not semantic classification.
A short, well-formed reasoning sentence that happens to satisfy every structural rule
could still be accepted; the design bounds that risk and does not claim a semantic
guarantee.

## Non-goals

- Changing the one-api proxy or any provider behaviour.
- Changing which models the lightweight/context utility slots resolve to.
- Renaming existing sessions, or adding a UI affordance for naming.
- Changing branch-summary, compaction, or transcript-polishing prompts or budgets.

## Approved behavior

### Title generation call

One title attempt is one model call with:

- **no `reasoning` option at all**, on every attempt, independent of the configured
  utility thinking level, and
- `maxTokens: 256` (a ceiling; the verified happy path spends 6 tokens),
- unchanged `SESSION_NAME_TIMEOUT_MS` (10s) and unchanged 4 000-character input
  truncation.

Omitting the option is the runtime's encoding of "off". `pi-ai`'s request type
`ThinkingLevel` is `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; only
`ModelThinkingLevel` (configuration) contains `"off"`, so passing the literal is a type
error and, on at least one adapter, enables thinking with a 1024-token budget instead of
disabling it. With the option omitted, a reasoning model resolves to
`reasoning.effort: "none"`, which the verified configured model honours (6-token title).
The repository's other utility consumers already encode off this way
(`speechInputPolishingService.ts:93-95` clamps and then omits). Models that keep thinking
anyway (the one-api deepseek route) still work because of the larger ceiling and the
acceptance rules below.

### Unchanged consumers of utility thinking levels

Branch summaries and compaction keep forwarding the configured utility
`thinkingLevel` (`utilityModelExtension`, `utilityExtension.ts:133-135, 220-223`).
Transcript polishing already ignores it: `speechInputPolishingService.ts:93-95` clamps
every candidate to `off` before the request, and existing tests pin that behaviour. This
design neither changes polishing nor claims it as new behaviour.

Only title generation stops forwarding the configured level. No configuration key, API
type, route, or UI element changes, and `context` slot behaviour is untouched. So the
approved boundary holds: thinking remains available to the lightweight consumers that
use it today, and the fix is confined to the session-name generator.

### Attempt acceptance

An attempt is accepted only when all hold:

1. the stream ends with a `done` event (no silent end-of-stream),
2. the final message `stopReason` is exactly `"stop"` — `length`, `toolUse`,
   `deferred`, `aborted`, `error`, and `pending` are all rejected,
3. every content block is `text` or `thinking` (a completion carrying tool calls or an
   unknown block type is rejected), following the existing `extractPolishedText`
   precedent in `speechInputPolishingService.ts:135-148`,
4. the normalized first line passes validation.

A rejected attempt is not a title. Rejections are classified for diagnostics as
`stream-error`, `no-completion`, `incomplete-stop` (a non-`stop` terminal reason),
`non-text-content`, `empty`, or `unusable`.

**Reason precedence:** when one completion fails several conditions, the first failing
condition in the numbered order above determines `reason`. That order is part of the
contract, so a completion that both ends with `toolUse` and carries a tool block reports
`incomplete-stop`, and an accepted-but-blank completion reports `empty` rather than a
validation failure.

### Attempt identity and deduplication

Because every title attempt omits the `reasoning` option, the effective request identity
is the model alone: `(provider, id)`. The existing resolver deduplicates on
`(provider, id, thinkingLevel)`, which would otherwise issue two byte-identical
requests — and consume two sequential timeout windows — when the configured
lightweight model is also the active session model at a different level.

Title attempts are therefore normalized to `thinkingLevel: "off"` **before** the
resolver's deduplication, so a same-model configured candidate and active-model
fallback collapse into one call. This is a declared behaviour change: the existing
test that preserves two calls for that case becomes a test that preserves one.

### Title validation and display shortening

Cleaning is split into two ordered stages so display shortening can never turn rejected
text into an accepted title:

1. **Normalize** — first line only, strip a leading `Title:`/`Session title:` label and
   surrounding quote characters, collapse whitespace, trim.
2. **Validate the normalized, uncapped text** — reject:

| Rule | Rationale |
| --- | --- |
| empty after normalizing | nothing to name with |
| more than 8 words | the contract is 2–6; observed legitimate titles are 1–8 words (`Fix flaky article bridge FTS retry test`) |
| instruction/reasoning echo: `no quotes`, `punctuation wrapper`, `2-6 word`, `the user wants`, `we need`, `need to (produce\|infer\|craft)` | the observed failure shape |
| dangling final connector: `and`, `or`, `for`, `the`, `a`, `an`, `to`, `with`, `of`, `in`, `on`, `by` | signature of a cut-off completion that reports `stop` |

3. **Shorten for display** — only after validation passes, cap at 60 characters. If a
   whitespace boundary exists at or before the cap, cut there and trim trailing
   punctuation-adjacent whitespace. If no whitespace boundary exists (a long identifier,
   URL, or unspaced CJK text), keep the first 60 **code points** so no surrogate pair is
   split; a lone token longer than the cap is therefore displayed as its 60-code-point
   prefix rather than rejected.

Validation is never performed on the shortened text, and shortening never changes an
acceptance decision.

### Deterministic fallback name

`fallbackSessionName` keeps its current shape (skill blocks and fenced code removed,
6-word slice) with two additions applied before the slice:

1. drop a leading `PM:` / `Project manager:` marker,
2. drop leading metadata lines (`Model tier: …`, `Role: …`) and a leading
   `You are (the|an|a)` clause.

So `PM: Bug: Utility models for session naming doesn't work` becomes
`Bug: Utility models for session naming` (six words), and
`You are the deterministic SDD lane runner for the f-worker lane of appio.` becomes
`deterministic SDD lane runner for the` (six words). The existing deterministic
relay-handoff name keeps precedence over both.

The fallback is not subject to the echo/word-count rules, because it is derived from the
user's own request rather than a model completion; it is still normalized and shortened.

**Declared empty outcome:** when the first request cleans to nothing — a code-only
request, a marker-only `PM:` request, or a metadata-only prompt — the session
intentionally remains unnamed. `applyGeneratedSessionName` keeps its current no-op guard,
and the session list continues to display that session's first message. This is the
existing behaviour, now explicit rather than accidental.

## Components

`src/server/sessions/sessionNameGenerator.ts` (pure, dependency-injected):

- `generateShortSessionName(streamFn, model, firstMessage)` — thinking level is no
  longer a parameter; always omits `reasoning` and sends `maxTokens: 256`. Returns
  `SessionNameGeneration`, a discriminated union:
  - `{ ok: true; title: string }`
  - `{ ok: false; reason: "stream-error" | "no-completion" | "incomplete-stop" | "non-text-content" | "empty" | "unusable" }`
- `normalizeSessionName(value: string): string | undefined` — stage 1 above.
- `isUsableSessionTitle(value: string): boolean` — the uncapped validation table above,
  exported for direct unit testing.
- `shortenSessionName(value: string): string` — stage 3, code-point safe.
- `cleanSessionName(value)` — normalize plus shorten, kept for the fallback path.
- `fallbackSessionName(firstMessage)` — scaffolding stripping added, including the
  declared empty outcome.
- `deterministicSessionName(firstMessage)` — unchanged.

`src/server/sessions/utilityModelResolver.ts`:

- `runWithUtilityModelFallback` gains one optional seam,
  `normalizeAttempt?: (attempt) => attempt`, applied to every candidate before the
  deduplication key is computed and before `run` is called. Omitting it preserves
  existing behaviour for branch-summary and compaction consumers.

`src/server/sessions/piSessionService.ts` `maybeGenerateSessionName`:

- drops the `attempt.thinkingLevel` argument,
- passes a `normalizeAttempt` that forces `thinkingLevel: "off"`, so attempts deduplicate
  by model identity,
- maps `ok: false` to `undefined` for the resolver chain after logging one `info` line
  per rejected attempt with `{ provider, modelId, reason }`; rejections are **not**
  routed through the resolver's `onFailure`, which fires only for thrown exceptions,
- applies `result.title`, else `fallbackSessionName(firstMessage)` exactly as today,
- keeps every existing lifecycle guard (closed session, tree navigation deferral,
  reentrancy) and the existing early return for a session with no model.

## Error handling

- Stream error, silent end-of-stream, truncation, and unusable text are ordinary
  rejections, not exceptions; the resolver chain already treats `undefined` results
  as "try the next candidate".
- An exception inside an attempt is caught by `runWithUtilityModelFallback` and
  logged by the existing `onFailure` hook.
- `applyGeneratedSessionName` keeps its guards: a closed session or an in-flight tree
  navigation never receives a late name.
- Rate-limit and timeout behaviour is unchanged.

## Test strategy

Pure-helper tests (`sessionNameGenerator.test.ts`), faked `StreamFn` with
`createAssistantMessageEventStream`:

- no `reasoning` option and `maxTokens: 256` on the request for every call;
- `stopReason: "length"` → no title returned, with the truncation reason;
- `stopReason` values `toolUse`, `deferred`, `aborted`, `error`, and `pending` →
  `incomplete-stop`, each covered so a non-answer terminal state cannot become a title;
- a completion containing a non-text block → `non-text-content`;
- stream ending without `done` → `no-completion`;
- a completion containing both a `thinking` block and a `text` block is **accepted**,
  so an implementation that rejects thinking blocks cannot pass;
- `stream-error` and `empty` classifications are each asserted directly;
- reason precedence: a completion that ends with `toolUse` and also carries a tool
  block reports `incomplete-stop`;
- an 11-word reasoning paragraph whose first 60 characters hold only 7 words →
  `unusable`, proving validation runs before shortening;
- reasoning-echo text → `unusable`; 7- and 8-word legitimate titles → accepted;
- dangling connector → `unusable`;
- shortening: word-boundary cut for a long legitimate title, and a 60-code-point prefix
  for an unspaced CJK value and for a single token longer than the cap;
- fallback scaffolding stripping for `PM: …`, `Model tier: …` + `You are the …`, the
  declared empty outcome for a code-only and a marker-only request, and the preserved
  relay and skill-block cases.

Service tests (`piSessionService.promptQueue.test.ts`):

- a truncated utility candidate falls through to the next candidate and the name is
  applied from the accepted one;
- one diagnostic `info` entry per rejected attempt carrying `provider`, `modelId`, and
  `reason`, including the last rejection before falling back;
- a same-model candidate and active fallback at different configured levels collapse
  into a single request (replacing the current two-call expectation);
- every candidate rejected → the deterministic fallback name is applied with its exact
  expected text (`Bug: Utility models for session naming` for the `PM:` example), and
  when that fallback itself cleans to nothing (code-only, marker-only, or metadata-only
  request) no name is applied and the session stays unnamed;
- a session with no resolved model dispatches no title request and stays unnamed;
- the **four** existing title assertions that encode the configured level
  (`reasoning: "high"` at `:132` and `:163-165`, `"minimal"` at `:192` and `:225-227`)
  now assert that the request carries **no `reasoning` property** alongside
  `maxTokens: 256`, which is the intentional behaviour change from commit `1033519`;
- the current different-level fixture (`:194-205`, which fails its first attempt and
  succeeds on the second) is rewritten as the discriminating case: the configured
  candidate and the active fallback are the same model at different configured levels,
  and that single attempt is **rejected**. The assertions are one stream call and the
  deterministic fallback name. This fixture fails if normalization is omitted or applied
  after the identity is computed (either would produce two calls and a generated name),
  so it — not a success-path fixture — is the proof of pre-deduplication normalization;
- a companion success-path case keeps the same-model, different-level pair applying the
  accepted title, with one call asserted;
- a resolver-level test in `utilityModelResolver.test.ts` keeps the omitted-seam
  behaviour pinned: without `normalizeAttempt`, level-distinct attempts still deduplicate
  separately.

Checks: focused test files, then `npm run typecheck`, then `npm run verify:fast`.
A `patch` changeset records the fix.

## Risks

- **Word-count and connector rules could reject a legitimate title.** The cost of a
  false rejection is the deterministic name, which is the same degradation path the
  feature already has; the threshold sits above every observed legitimate title.
- **A short, well-formed reasoning sentence can pass every structural rule.** Accepted
  by design: the guarantee is over format, not semantics, and is stated as such.
- **A model that ignores the omitted reasoning option still spends tokens.** The 256 ceiling
  covers the observed 96-token reasoning cost of the deepseek route.
- **Provider-specific proxy leakage could take another shape.** The rules are
  deliberately structural (length, echo markers, trailing connector), not
  provider-specific.
