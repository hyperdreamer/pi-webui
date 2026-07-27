# Anthropic model-discovery endpoint fix — Implementation Plan

**Status:** Review-ready implementation plan; pending a separate Team Leader feasibility review. This document does not approve execution, integration, a candidate, or any release gate.

**Approved input:** [`docs/superpowers/specs/2026-07-26-anthropic-model-discovery-design.md`](../specs/2026-07-26-anthropic-model-discovery-design.md), approved by the Product Owner on 2026-07-26.

**Baseline:** `a95014823a4e5720697afee38114214af15c84a8`. At planning inspection, `HEAD` equalled this SHA, there were no tracked diffs from it, and the approved brief was the sole untracked file. The brief is intentionally untracked, so an execution worktree must not be expected to contain it automatically.

**Task count:** 1 sequential, isolated Programmer task. The production change, focused test, and patch Changeset share the same behavior and review evidence, so splitting them would add coordination without an independent implementation boundary.

## Purpose and bounded behavior

`ModelsConfigService.discover()` currently passes every non-Google provider through `modelDiscoveryEndpoint()`, which resolves `"models"` relative to the configured Base URL. That is correct for a versioned OpenAI-compatible Base URL but wrong for the root-style URL required by Pi's `anthropic-messages` runtime.

The implementation keeps the service boundary and public types unchanged. Its only production decision is the relative discovery path selected by the existing private helper:

| Provider API format | Configured Base URL contract | Relative discovery path | Example result |
| --- | --- | --- | --- |
| `anthropic-messages` | API root; no automatic Base URL rewrite | `"v1/models"` | `https://www.rightapi.ai/claude-aws/v1/models` |
| all other formats | Existing contract | `"models"` | Existing OpenAI-compatible and Google results remain unchanged |

The Anthropic path must be exactly the relative string `"v1/models"`. A leading slash would make `URL` discard a configured path prefix. Do not add a fallback, retry, origin rewrite, or `/v1` normalization. In particular, a user-supplied Anthropic Base URL ending in `/v1` remains outside the supported root-URL contract and must not be silently corrected.

No client, route, `models.json` schema, Pi runtime, connection-test implementation, dependency, migration, or configuration change is part of this plan. The existing connection-test/runtime path continues to receive the configured root URL and lets the Anthropic runtime derive `v1/messages`; this task must not alter that flow.

## Change surface and interface contract

| Path | Action | Exact responsibility |
| --- | --- | --- |
| `src/server/models/modelsConfigService.ts` | Modify | In private `modelDiscoveryEndpoint(baseUrl, api, apiKey): URL`, choose the relative endpoint path before calling the existing `new URL(...)` construction. Keep its signature, HTTP(S) validation, Google key query handling, and all downstream calls unchanged. |
| `src/server/models/modelsConfigService.test.ts` | Modify | Add service-level Anthropic discovery coverage through the existing injected `createConnectionRuntime` and stubbed global `fetch` seam; retain the existing Google and OpenAI-compatible tests. Widen only the file-local `discoveryRuntime()` test helper's header-map type if needed to model `null` suppressions. |
| `.changeset/anthropic-model-discovery.md` | Create | Record the user-visible compatible bug fix as one patch Changeset for `@hyperdreamer/pi-webui`; do not edit `CHANGELOG.md`. |

The exercised data flow remains:

```text
ModelsConfigService.discover(request)
  -> parseModelDiscoveryRequest(request)
  -> isolated ModelRuntime.getAuth(providerName)
  -> modelDiscoveryEndpoint(baseUrl, api, apiKey)
  -> fetchModels(endpoint, api, apiKey, resolved headers)
  -> parseDiscoveredModels(response, api)
```

`ModelsConfigServiceDependencies.createConnectionRuntime` remains the explicit test seam. Tests must assert the observable `fetch` URL and request headers rather than export or directly test the private endpoint helper.

## Early consultation record

| Consultant | Advice | Plan disposition |
| --- | --- | --- |
| Team Leader | One isolated task is feasible. Required order: clean baseline, focused expected-URL RED, minimum endpoint-path selection, GREEN/regression evidence, then patch Changeset. The daemon needs a manual restart after eventual integration. | Accepted. Task 1 is sequential and includes the exact baseline, RED, GREEN, Changeset, review, and daemon-restart requirements. |
| Security | Use exact relative `"v1/models"` for `api === "anthropic-messages"`; never use a leading slash. Preserve HTTP(S) validation and existing headers/defaults/suppressions. Do not add fallback, origin rewrite, or `/v1` normalization. | Accepted as the production contract and review criteria. The helper selection is the only production edit; `fetchModels()` and validation remain untouched. |
| QA | Use the current service-level injected-runtime plus stubbed-`fetch` seam. Parameterize root URLs with and without a trailing slash, assert the expected URL and Anthropic defaults, and retain OpenAI/Google regressions. The URL mismatch is the only RED proof. | Accepted. The focused test uses hand-derived literal URLs and places the URL assertion before header checks; configured-header behavior is covered without treating it as a new failure being fixed. |

## Task 1: Correct Anthropic root-URL model discovery

**Outcome:** A custom provider whose `api` is `"anthropic-messages"` discovers models from its configured root URL plus `v1/models`, whether or not the root includes a trailing slash. Every other provider format continues to use its current discovery path.

**Task worktree and ownership:** After Team Leader feasibility approval, the Team Leader creates and records one isolated Programmer worktree from `a95014823a4e5720697afee38114214af15c84a8`. The Programmer receives this task's generated brief, not the primary checkout, and submits one reviewable commit. The Programmer must run `source yesconda` before its first system action and before each isolated-shell command.

### Step 1: Preserve workflow inputs and establish the clean baseline

1. The Team Leader must make the approved brief and this plan available as read-only task inputs before generating the Programmer brief. Since the approved brief is untracked, record its absolute path and content identity in the execution ledger or copy the required requirements into the generated task brief; do not assume `git worktree add` transfers it. Apply the same evidence treatment to this untracked planning artifact if it has not been committed by the time execution starts.
2. In the assigned task worktree, record the path, branch, base SHA, and clean status. A dirty task worktree or a baseline failure is a Team Leader blocker, not RED evidence.
3. Before editing either production or test code, run and record:

   ```bash
   source yesconda
   git rev-parse HEAD
   git status --short
   npm test -- --run src/server/models/modelsConfigService.test.ts
   ```

   Expected baseline: `HEAD` is `a95014823a4e5720697afee38114214af15c84a8`, `git status --short` is empty in the task worktree, and the existing focused service test file passes. If the command does not meet that expectation, stop and return the evidence to the Team Leader for triage.

### Step 2: Add the behavior-specific failing service tests (RED)

Edit only `src/server/models/modelsConfigService.test.ts` first. Keep the real `ModelsConfigService.discover()` path, temporary models document handling, injected runtime seam, and stubbed `fetch` boundary intact; do not mock the service or its private helper.

1. Add an `it.each` Anthropic discovery test with these hand-derived input/output rows:

   | `provider.baseUrl` input | Required fetched URL |
   | --- | --- |
   | `https://www.rightapi.ai/claude-aws` | `https://www.rightapi.ai/claude-aws/v1/models` |
   | `https://www.rightapi.ai/claude-aws/` | `https://www.rightapi.ai/claude-aws/v1/models` |

   In every row, construct a fresh temporary agent directory and `ModelsConfigService`; inject `discoveryRuntime("anthropic-key", { "x-tenant": "anthropic-default" })`; and stub `fetch` with a `200` `Response` containing `JSON.stringify({ data: [{ id: "claude-test", name: "Claude Test" }] })`. Call `discoverModels()` with `providerName: "anthropic-custom"`, `api: "anthropic-messages"`, and the row's root-style `baseUrl`, then expect `{ models: [{ id: "claude-test", name: "Claude Test" }] }`.

   Inspect the first fetch call through the existing `fetchUrl()` helper and assert the literal required URL above **before** inspecting headers. Then assert that `x-api-key` is `anthropic-key`, `anthropic-version` is `2023-06-01`, `x-tenant` is `anthropic-default`, and `authorization` is absent. This exercises the real service's request boundary while faking only the external network.

2. Change only the file-local `discoveryRuntime()` helper parameter from `Record<string, string>` to `Record<string, string | null>` so the fake exactly mirrors the resolved-auth header contract already accepted by `fetchModels()`. Do not add a production-only testing API.

3. Add one narrow table-driven header-precedence test that uses the same service and fetch seam, a root Base URL of `https://www.rightapi.ai/claude-aws`, and the same successful model response. Its injected resolved-auth header cases and required observable results are:

   | Case | Injected `discoveryRuntime()` headers | Required request headers |
   | --- | --- | --- |
   | configured addition and override | `{ "x-tenant": "anthropic-tenant", "x-api-key": "configured-key", "anthropic-version": "2024-01-01" }` | `x-tenant` is `anthropic-tenant`; `x-api-key` is `configured-key`; `anthropic-version` is `2024-01-01` |
   | configured suppression | `{ "x-tenant": "anthropic-tenant", "x-api-key": null, "anthropic-version": null }` | `x-tenant` is `anthropic-tenant`; `x-api-key` and `anthropic-version` are absent |

   Assert each discovery result is parsed successfully and inspect `new Headers(options?.headers)` for the stated observable values. This coverage verifies pre-existing configured-header behavior; it is not a second production behavior change and it must not be used as RED evidence.

4. Preserve the existing Google and OpenAI-compatible test cases and their exact URL/credential assertions. The new tests must make no live network request and must continue to rely on `afterEach()` cleanup for global `fetch` stubs and temporary directories.

Run the focused test file before any production edit:

```bash
source yesconda
npm test -- --run src/server/models/modelsConfigService.test.ts
```

Expected RED evidence: the new Anthropic root-URL rows fail because the received URL is `https://www.rightapi.ai/claude-aws/models` while the hand-derived expected URL is `https://www.rightapi.ai/claude-aws/v1/models`. The URL mismatch is the only intended new failure; the existing Google/OpenAI cases and Anthropic header behaviors are not the defect under repair. Capture the command and failure output before modifying `modelsConfigService.ts`.

The test protects realistic mutations: retaining the generic `"models"` branch, choosing a leading `"/v1/models"` path that drops `claude-aws`, omitting `v1`, or changing the non-Anthropic branch must fail an observable URL or regression assertion.

### Step 3: Implement the minimum endpoint-path selection (GREEN)

Edit `src/server/models/modelsConfigService.ts` only after the RED output is recorded.

1. In `modelDiscoveryEndpoint(baseUrl, api, apiKey)`, introduce one intention-revealing local value before the existing `new URL(...)` call:

   ```ts
   const endpointPath = api === "anthropic-messages" ? "v1/models" : "models";
   ```

2. Pass `endpointPath` as the first argument to the existing `new URL(...)` expression, retaining the existing trailing-slash normalization of the Base URL.
3. Leave the following code and behavior unchanged:
   - the helper signature and its `baseUrl` required check;
   - the `http:`/`https:` validation;
   - Google API-key query parameter behavior;
   - `fetchModels()`, including resolved credentials, `accept`, Anthropic defaults, configured-header additions/overrides/suppressions, timeout, and abort handling;
   - all model parsing, isolated runtime creation, connection-test code, routes, client code, and session-daemon ownership.

Do not add a leading slash, fallback request, retry, Base URL rewrite, `/v1` de-duplication, configuration migration, dependency, or exported abstraction. The local relative-path selection is the smallest clear server-side boundary change and keeps the existing injectable service test seam intact.

### Step 4: Prove GREEN and record regression evidence

After the production edit, run and record the following from the isolated task worktree:

```bash
source yesconda
npm test -- --run src/server/models/modelsConfigService.test.ts
npm run typecheck
npx eslint src/server/models/modelsConfigService.ts src/server/models/modelsConfigService.test.ts
git diff --check
```

Expected GREEN evidence:

- both root URL forms fetch exactly `https://www.rightapi.ai/claude-aws/v1/models`;
- Anthropic default, configured-addition, override, and suppression header assertions pass;
- existing Google and OpenAI-compatible discovery assertions still pass;
- TypeScript and ESLint report no errors; and
- `git diff --check` reports no whitespace errors.

Perform a self-review before committing: the only production diff is the local endpoint-path selection in `modelDiscoveryEndpoint()`; it uses relative `"v1/models"`; no request can discard a configured path prefix; and no unrelated behavior or source path changed.

### Step 5: Add the patch Changeset and submit the task for review

Create exactly `.changeset/anthropic-model-discovery.md` with the package name from `package.json` and user-facing patch wording:

```md
---
"@hyperdreamer/pi-webui": patch
---

Fix model discovery for Anthropic custom providers configured with root-style base URLs.
```

Validate the release metadata without generating a version or hand-editing `CHANGELOG.md`:

```bash
source yesconda
npm run changelog:status
git diff --check
```

Expected result: Changesets recognizes one valid pending patch change and the whitespace check passes. Do not run `npm run release:version`, create a release, or publish.

Create one task commit containing exactly the planned production file, focused test file, and Changeset:

```bash
source yesconda
git add src/server/models/modelsConfigService.ts \
  src/server/models/modelsConfigService.test.ts \
  .changeset/anthropic-model-discovery.md
git commit -m "fix: discover Anthropic models from v1 endpoint"
git status --short
```

Expected result: a reviewable task commit and an empty task-worktree status. The Programmer submits the commit SHA, baseline/RED/GREEN/quality command outputs, changed-path list, and self-review notes to the Team Leader; it does not merge or declare a gate passed.

## Team Leader review, integration, and candidate requirements

The Team Leader must separately assess feasibility before execution and, after task submission, own the task Code Review Gate. Review must reject the task if RED evidence was captured after the production edit or if any requirement below is absent.

### Task review criteria

- The commit is based on the recorded isolated-worktree baseline and changes only the three planned paths.
- The recorded RED command predates the production edit and fails specifically on the Anthropic expected URL rather than setup, parsing, or an unrelated error.
- `modelDiscoveryEndpoint()` selects exactly `"v1/models"` only for `api === "anthropic-messages"`; the value has no leading slash and the non-Anthropic path remains `"models"`.
- The existing Base URL trailing-slash handling and HTTP(S) validation remain intact, so a configured origin path prefix is preserved.
- No fallback, retry, origin rewrite, `/v1` normalization, runtime, connection-test, route, client, schema, dependency, or migration change appears in the diff.
- `fetchModels()` retains resolved-credential behavior, Anthropic defaults, configured additions/overrides/suppressions, timeout, and error behavior; the tests prove the observable header cases required by the brief.
- Both root URL forms and existing Google/OpenAI-compatible cases pass through the service-level seam, with no live network traffic.
- The Changeset is a patch for `@hyperdreamer/pi-webui`, is user-facing, and `CHANGELOG.md` remains unedited.

Only after task review passes may the Team Leader serially integrate the approved task commit into the dedicated integration branch. The Team Leader then runs the full candidate verification:

```bash
source yesconda
npm run verify
git diff --check
```

`npm run verify` is expected to pass typecheck, lint, Knip, and the full Vitest suite. The Team Leader coordinates an independent whole-candidate review and records the authoritative aggregate Code Review verdict. Only a passing aggregate review and aggregate verification may freeze a release-candidate SHA.

Security and QA must receive that same immutable frozen SHA, not a branch or worktree. Security verifies the relative-path/prefix-preservation and header/security constraints; QA reruns the required focused and aggregate evidence against the SHA. Any security or functional finding returns to the Team Leader for bounded remediation, new aggregate review, a new candidate SHA, and required revalidation; no earlier candidate approval carries forward.

After same-SHA Security and QA passes, the PM performs product acceptance against the approved brief. Documentation/release preparation must use the patch Changeset as the release-note input; `CHANGELOG.md` is generated only during release preparation. Operational readiness and explicit PM approval remain required before any deployment.

## Session-daemon operation and rollback

`ModelsConfigService` is session-daemon-owned. After eventual integration in a running local environment, UI/API autoreload is insufficient: an operator must manually restart the long-lived daemon before manually validating the new behavior:

```bash
source yesconda
systemctl --user restart pi-webui-sessiond.service
```

That restart is an operational instruction for the eventual integrated candidate, not an action authorized by this planning phase. No UI/API service restart, deployment, or candidate freeze occurs as part of this plan.

There is no migration, persistent data mutation, or configuration transformation to unwind. Before candidate freeze, a failing task is abandoned or reverted in its isolated branch and returned through the Team Leader. After deployment, an unhealthy release is rolled back first to the previously approved candidate according to the deployment procedure, then investigated through the normal remediation path. If a source rollback is required, it is limited to reverting the endpoint-path selection, its focused tests, and the corresponding Changeset under Team Leader control; the restored daemon version also requires the manual session-daemon restart.

## Plan self-review and next permitted action

This plan covers every approved acceptance criterion: two root-URL forms, the unchanged runtime/connection-test boundary, Anthropic credentials/defaults/configured headers, OpenAI/Google regressions, pre-production RED evidence, minimum GREEN implementation, patch Changeset, focused and aggregate verification, candidate-specific Security/QA gates, session-daemon operation, and rollback. It introduces no unresolved product choice, placeholder, or scope expansion.

**Next permitted action:** submit this review-ready plan to the Team Leader for feasibility review. A feasibility rejection for a technical or sequencing issue returns to the Architect; a product-scope or acceptance issue returns to PM discovery; a combined issue returns to Architect and PM.
