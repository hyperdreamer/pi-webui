# Per-Model TPM and PRM Controls

Date: 2026-09-13
Status: Initial written design approved by the user, including the existing Models settings GUI workflow. Frontier review passed with no blocking issues; review clarifications are incorporated below. The technical specification is next.

## Background and Goals

PI WEBUI edits the active machine's Pi `models.json` and owns long-lived model sessions in `sessiond`. Add optional throttling controls directly to individual model entries, without modifying the installed Pi harness or changing provider request payloads.

The earlier proposal for one cross-model global budget was rejected. The intended sharing rule is:

- Calls to the same provider and model ID share one budget across sessions, projects, root sessions, spawned sessions, and PI WEBUI utility operations in that daemon.
- Different model IDs have independent budgets, even within the same provider.
- The same model ID under different provider names has independent budgets.
- Thinking level, model tier, display name, and session identity do not partition the budget.

Limits are local to the daemon and its active agent profile. Separate machines, separate daemon processes, standalone Pi CLI instances, and external applications do not coordinate usage through this feature.

## Confirmed Product Decisions

| Concern | Decision |
| --- | --- |
| Storage | `tpm` and `prm` directly on `providers[provider].models[]` entries |
| Budget identity | Exact provider name plus exact model ID |
| TPM | Actual `input + output + cacheRead + cacheWrite` tokens reported by the model call |
| PRM | Requests per minute; retain the user's `prm` spelling |
| Window | Rolling 60 seconds, not calendar-minute buckets |
| On exhaustion | Queue calls in FIFO admission order for that model |
| Cancellation | Remove cancelled waiters before dispatch; preserve originating cancellation |
| Disabled limits | Omission or `0`, independently for each dimension |
| UI | Option A: a visible Rate limits section inside each model editor |
| Harness compatibility | PI WEBUI owns enforcement; Pi may ignore the additional fields |

## Configuration Contract

Example within an otherwise valid provider configuration:

```json
{
  "providers": {
    "example-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$EXAMPLE_API_KEY",
      "models": [
        {
          "id": "model-large",
          "tpm": 100000,
          "prm": 60
        },
        {
          "id": "model-small",
          "tpm": 300000,
          "prm": 120
        }
      ]
    }
  }
}
```

Each field accepts a non-negative safe integer. Reject strings, booleans, null, negative values, fractions, non-finite numbers, and integers outside JavaScript's safe range. Blank UI input removes the field; an existing explicit zero remains valid. No limit inherits from the document root, provider, or another model.

Extend `ModelsConfigModel`, not `ModelsConfigDocument` or `ModelsConfigProvider`, with the optional typed fields. Preserve unrecognized document, provider, and model fields through parsing and editing. Do not reinterpret, move, or remove existing top-level/provider `tpm` or `prm` fields; they remain opaque and do not activate a limit.

This initial feature recognizes limits only on explicit `models[]` entries. It does not add a second syntax under `modelOverrides`, synthesize catalog entries, or change Pi's built-in/custom-model merge rules. Models absent from these entries are unlimited. Adding a custom entry that matches a built-in model continues to replace that built-in definition under Pi's existing rules; rate-limit editing must not silently create such replacements.

Provider/model identities must be collision-safe, not formed by ambiguous separator concatenation. Changing display names or reordering distinct IDs does not change identity. If duplicate model IDs exist in a provider array, the last entry owns both rate-limit values, matching Pi 0.85.1's sequential model upsert ordering. An omitted field on that last entry disables that dimension; it must not inherit a value from an earlier duplicate. Pin this behavior in SDK compatibility tests.

### Pi Compatibility Evidence

The installed Pi 0.85.1 `ModelConfig` schema defines model objects without forbidding additional properties and retains cloned provider configuration. It has no native TPM/PRM enforcement. PI WEBUI must read the limits from its validated configuration snapshot rather than rely on unknown fields surviving conversion to runtime `Model` objects.

The limit loader and the Models dialog read/save path must use one production parser with Pi-compatible semantics: optional leading BOM, line/block comments, and trailing commas. Do not use the dialog's current empty-document fallback for a file that failed parsing. If the active file cannot be parsed, the GUI must show the configuration error and refuse Save rather than replace the file with an empty document. The parser choice must be explicit in the technical specification: use a maintained production dependency or a small vendored parser with tests matching Pi's accepted syntax. The parser must preserve unknown fields when the document is edited; formatting/comments need not be preserved if the existing serializer already normalizes the document, but a parse failure must never be treated as an empty document.

Do not mistake a valid Pi file for a startup failure because plain `JSON.parse` rejects comments. Keep validation of rate-limit fields separate from document parsing: a syntactically valid document with an invalid limit is rejected and reported, not activated as unlimited. Implementation verification must load a valid fixture containing the new fields through the installed public Pi runtime and compare model behavior with the same fixture without them. Provider API, authentication configuration, reasoning, context/output limits, compatibility settings, and catalog resolution must remain unchanged. No SDK fork, installed-package edits, or transport payload injection is part of this design.

## UI Design

The user selected **A: dedicated visible section**, rejecting **B: hidden inside Advanced**. The configuration surface is the existing **Models settings > Model configuration** dialog shown in the user's screenshot, not a separate settings page or a raw-JSON-only feature. Preserve the existing provider tree, model selection, dialog actions, and machine targeting.

Selecting a model in the left tree loads its saved TPM and PRM values into editable numeric inputs. Users can set, change, or clear either value entirely through this GUI. The dialog's existing **Save** button persists the values on that model's `models.json` entry for the selected machine and activates the accepted limits. Closing and reopening the dialog must show the saved values; no manual file editing is required.

Place the section after Context window / Max output tokens and before Cost:

```text
Model: model-large

Context window (tokens)             Max output tokens
[128000                   ]        [16384                  ]

Rate limits
Tokens per minute (TPM)             Requests per minute (PRM)
[100000                   ]        [60                     ]

Cost
Input        Output        Cache read        Cache write
...

> Advanced model fields
```

The rejected option was:

```text
> Advanced model fields
    Tokens per minute (TPM)
    Requests per minute (PRM)
    Compatibility
```

Use the existing field styling and a two-column numeric-input layout that becomes one column when narrow. The section is unframed, not a nested card. Blank fields use an `Unlimited` placeholder. Labels and validation messages must fit at mobile widths, and invalid input must not be rounded or silently converted to unlimited.

Keep invalid draft text and its validation state associated with the selected model. Draft identity must not be a mutable array index: use provider/model identity plus a duplicate-entry occurrence identity, and clear or remap it deliberately when an entry is explicitly deleted. Save must not submit a document containing an invalid rate-limit draft, including an invalid draft on a different model after navigation. Machine changes and reloads must not carry draft errors or asynchronous results into a different configuration. Use existing modal lifecycle protections and feedback patterns. No live usage dashboard, countdown, or new session-status protocol is introduced.

## Architecture and Alternatives

### Selected: One Daemon-Owned Limiter with Narrow Call Adapters

Create one model-rate-limit owner during `sessiond` startup. It contains independent histories and queues keyed by provider/model. Sharing one owner is a lifecycle decision, not one shared cross-model budget.

Separate these responsibilities:

1. **Configuration validation and extraction:** build an immutable per-model limits snapshot from `models.json`, preserving the editable document.
2. **Admission and accounting:** own rolling histories, FIFO waiters, cancellation, configuration updates, and timer cleanup behind a small testable interface. Inject a monotonic clock and timer functions; no filesystem, HTTP, or UI dependencies belong here.
3. **Model-call adapters:** wait for admission before invoking the underlying model call, and record its terminal usage once. Adapt Pi's stream interface and the two direct completion surfaces without duplicating limiter policy.
4. **Composition and persistence:** `sessiond` shares the owner; `ModelsConfigService` validates, saves, refreshes, and publishes accepted limits.

Wrap each SDK-created session's existing public `agent.streamFunction` before the factory returns it, and publish that same wrapped function through `UtilityModelExtensionRuntimeRefs`. Preserve the original delegate and its auth, header, retry, thinking-level, and abort options. This covers Pi compaction/branch-summary paths that already use the agent stream function, as well as PI WEBUI utility calls. Do not wrap the shared runtime underneath that stream as well, which would double-count calls.

Speech polishing receives a completion adapter over the shared runtime. Model connection checks retain their isolated runtime and credentials behavior but pass the final completion through the same limiter owner. A connection check must not install a second limiter or alter active limits from an unsaved draft.

### Alternatives Not Selected

- **Independent limiters in each session/service:** cannot enforce the shared budget for a model across concurrent callers and duplicates coordination logic.
- **Fork, subclass, or broadly monkey-patch `ModelRuntime`:** couples PI WEBUI to private/runtime implementation details and is unnecessary when public stream and completion interfaces are already available.

If an SDK lifecycle path cannot be covered through these interfaces, identify it during design/spec review rather than claiming universal coverage or introducing an unreviewed SDK patch.

### Covered Model Calls

| Call surface | Integration point |
| --- | --- |
| Interactive prompts, tool-loop continuations, follow-ups, steering, spawned sessions | SDK-created session agent stream function |
| Automatic/manual compaction and branch summaries, including ordinary-model fallback | Agent stream function and existing utility extension stream reference |
| Session naming and PI WEBUI utility fallback candidates | Existing calls through the session stream function, keyed by the actual candidate model |
| Speech-input polishing | Injected `completeSimple` adapter |
| Models dialog connection checks | Completion adapter around the isolated test runtime |

Model discovery, catalog refresh, authentication, transcription/speech transport, and deferred-result retrieval/cancellation are not new generation calls and are not charged by this feature. Extensions that call external SDKs or replace/bypass PI WEBUI's model-call interfaces are outside the enforcement contract.

## Rolling-Window Semantics

Use a monotonic time source. At time `now`, retain entries with timestamps strictly greater than `now - 60000`; an entry expires exactly 60 seconds after its timestamp.

For a model, admit the head waiter only when both enabled conditions hold:

- The number of dispatched requests still in the rolling request history is less than `prm`.
- The sum of reported token usage still in the rolling token history is less than `tpm`.

Recheck admission and record one request in the same synchronous decision, before calling the delegate. Concurrent admissions cannot spend the last request slot twice. FIFO governs dispatch order, not completion order. Requests for other models continue independently; there is no cross-model head-of-line blocking.

TPM is charged when a terminal assistant result is observed, using `input + output + cacheRead + cacheWrite`, and expires 60 seconds after that observation. Do not add `totalTokens` again, reserve `maxTokens`, estimate the prompt, or count each streaming delta. Record usage before forwarding the terminal event/result so immediate follow-up calls see it.

Count any valid reported terminal usage on successful, failed, or aborted calls exactly once. Missing or invalid individual counters contribute zero, never a negative credit or `NaN`; do not invent unreported usage. A thrown error without usage still consumes its dispatched PRM unit. Record bounded diagnostics without logging prompts or credentials.

**Actual-usage accounting is not a hard token ceiling.** Any admitted request, including the first one, can report more tokens than the limit. Concurrent in-flight calls can also overshoot it. Already-dispatched calls are allowed to finish; later calls wait until recorded usage falls below the limit. No additional one-request-at-a-time restriction is implied.

PRM measures admission to an underlying SDK model call, not every HTTP attempt inside an opaque provider transport. Application-level retries that invoke the model-call interface again are new requests. Internal transport retries are part of that invocation and retain Pi's behavior. This feature is local throttling, not an exact reconstruction of a provider's account quota or hidden retry traffic.

## Waiting, Cancellation, and Stream Lifecycle

- Do not invoke the delegate, allocate its response stream, or spend a PRM unit while a request is waiting for admission.
- Already-aborted calls settle as cancelled immediately. Aborting a waiter removes it without a request charge, including cancellation of the queue head. Recheck cancellation at dispatch to close the admission race.
- After dispatch, pass cancellation to the original call and retain its request charge. Reported final usage still belongs to that model even if the caller has already stopped waiting.
- A stream adapter must eagerly drive the delegate stream so `.result()`-only consumers receive the terminal result and terminal accounting still occurs. It must have one terminal-accounting guard shared by iteration and result paths, record usage before forwarding the terminal event/result, settle once, preserve event ordering, and translate pre-dispatch failures into the normal terminal error/abort representation. Handle synchronous delegate throws and unsuccessful stream termination without stranded waiters or promises.
- Wake waiters when relevant history expires or configuration changes. Cancel obsolete timers and abort listeners. Do not poll, busy-wait, or create timers for individual token deltas.
- Preserve existing caller deadlines, including speech-polishing and connection-test bounds. Time spent waiting counts against an existing end-to-end deadline; a timed-out call must not dispatch later. Ordinary sessions have no new arbitrary queue timeout.
- Browser disconnects or web/API autoreloads do not cancel daemon-owned sessions. Session stop/disposal and daemon shutdown remove their pending calls and timers through their actual cancellation paths.

## Configuration Lifecycle and Error Handling

Load the limits snapshot from the active profile during daemon startup. Serialize Models configuration save, runtime refresh, and publication so an older save cannot publish over a newer accepted configuration. Publish validated limits only after persistence and a narrowly defined successful runtime refresh/load validation; transient model availability, authentication, or catalog errors must not be confused with a configuration refresh failure. Do not report a successful save if persistence or required configuration refresh fails.

Expose startup and save validation failures through the existing Models configuration API/dialog error feedback, including the affected file/model and the reason. A daemon with no valid startup snapshot fails model admission closed with a structured configuration error until a valid document is accepted through the Models GUI; it must not silently queue indefinitely or appear unlimited. Once the GUI accepts and persists a valid document, publish it and wake eligible waiters.

Changing a limit affects waiting and subsequent calls without stopping in-flight work. Lowering a limit can lengthen a wait; raising or disabling it wakes eligible waiters immediately. Keep recent usage across limit changes, including disabled dimensions, so a toggle or ordinary provider edit does not reset the rolling budget. Remove expired history and idle entries when no waiter or in-flight call still needs them.

Removing a model's limit removes the admission restriction but does not cancel its work. Removing a provider/model configuration does not retarget a queued call to a different model. A rename is a different identity; already-started calls retain their original identity for accounting. Preserve normal SDK behavior if that original model is no longer usable when dispatched.

A missing `models.json` means no limits. A malformed existing document or invalid limit must not silently become unlimited. Keep a last-known-good active limits snapshot on load failure and report the validation problem. If there is no valid startup snapshot, keep configuration/error-reporting routes available but fail model admission closed until a valid configuration is accepted. Do not change this to a credential/network retry loop.

Failed persistence leaves active limits unchanged. Use the existing write semantics only if they are already crash-safe; otherwise write the new document to a sibling temporary file, fsync it, and atomically rename it before publishing. If a file write succeeds but runtime refresh fails, report the save failure and retain the last accepted active snapshot; acknowledge that the file and live state differ until a successful save or restart. This feature does not promise a cross-file transaction with Pi's runtime.

Saving through PI WEBUI activates accepted limits without restarting the daemon. For this initial version, external file edits require a daemon restart to guarantee limit reload; no new file watcher is introduced. Reloading the Models dialog reads the draft but does not itself publish limits. Document this distinction from Pi's own model-catalog refresh behavior.

A connection check uses the saved limits for its provider/model identity; unsaved draft limits neither replace live settings nor create a private budget. An unconfigured new model therefore has no saved limit. Its existing timeout still applies while queued.

## Scope Boundaries and Operations

This work does not add global limits, provider-wide limits, tier limits, shared API-key pools, distributed coordination, persistent usage history, billing changes, provider-rate-limit discovery, or adaptive 429 handling. It does not reinterpret TPM as a request-size/output cap.

Keep detailed user guidance in `docs/config.md` and `docs/config.html`, with operational troubleshooting in the existing FAQ only where necessary. Keep README concise. Include the feature's release note through the repository Changeset workflow during implementation.

Installing the implementation requires a **manual restart of `pi-webui-sessiond.service`**, because daemon-owned execution paths change. Do not automatically restart the running daemon during development. Later saves of limit values are live. UI-only changes use the existing UI development-service autoreload path. Daemon restart discards rolling histories; web/API restart does not.

## Verification Strategy

Implementation follows the repository testing and architecture guides. This design document does not claim that these tests or production changes exist yet.

1. **Configuration contracts:** omitted/zero/positive values; invalid types and bounds; model-local storage only; unknown fields preserved; identity collisions, duplicate-entry resolution, and isolation between providers/models.
2. **Pi compatibility:** load equivalent fixtures with/without rate-limit fields through the installed Pi runtime without network access; include Pi-compatible comments/BOM and duplicate IDs; prove model semantics and credentials configuration are unaffected and source files are not rewritten.
3. **Limiter behavior:** fake monotonic clock/timers; exact expiry boundary; request and token windows with different timestamps; all four usage counters; equality at the limit; overshoot; disabled dimensions; multiple waiters; no starvation from cancelled heads; unrelated models progressing.
4. **Lifecycle:** already-aborted, queued-aborted, dispatch-race, in-flight-aborted, thrown delegate, duplicate terminal observation, missing usage, timed-out waiters, shutdown, and no leaked timers/listeners or delayed dispatch after cancellation.
5. **Integration:** two independently created sessions share one model's budget; interactive, compaction, branch-summary, naming, speech, and isolated connection-test calls all reach that owner exactly once; utility fallback charges the actual selected model. Use installed SDK behavior at a focused integration layer where a fake alone would conceal a missing hook.
6. **Live configuration:** serialized saves and refresh failures; last-known-good behavior; invalid startup recovery through the Models settings GUI; changes preserve recent usage; increasing/disabling limits wakes waiters; unsaved connection-test values do not mutate live limits. Include persistence-crash recovery and prove an invalid external file is reported rather than replaced by `{providers:{}}`.
7. **Client behavior:** model-local drafts, saving/clearing, invalid drafts across selection, same-machine versus switched-machine completion ownership, and visible Rate limits controls. Exercise the existing Models settings GUI end to end: select one model, edit TPM/PRM, use Save, reopen and verify persistence, verify another model is unchanged, then clear a limit and save. Prefer DOM/component tests; do not use template extraction to claim layout or accessibility coverage.
8. **Browser geometry:** verify desktop and narrow mobile screenshots for field placement, readable labels/errors, keyboard focus, and absence of overlap, using the existing dialog rather than a standalone replacement.

Run focused Vitest files first, followed by typecheck/lint and `npm run verify:fast` for routine cross-cutting verification. Run `npm run verify` and the required frontier implementation audit before the delivery gate; do not run full suites alongside heavy child work. No merge into the delivery target occurs without the user's later delivery choice.

## Review Gate

The user has approved this written design, including per-model budgets and visible editable controls in the existing Models settings dialog. Frontier review passed with no blocking issues; its recommendations have been made explicit for specification and implementation. The precise technical specification is next and requires separate user sign-off. Implementation planning and production edits have not started.
