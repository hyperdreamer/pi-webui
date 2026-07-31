# Tiered session model policy and deterministic SDD — design

**Status:** Approved specification.

**Date:** 2026-07-31

**Supersedes:** [Exact subsession model and thinking selection](./2026-07-30-exact-subsession-model-thinking-selection-design.md) and its [implementation plan](../plans/2026-07-30-exact-subsession-model-thinking-selection.md).

## Goal

Give every PI WEBUI session an explicit model-selection mode:

- **Exact** — the user selects an exact provider, model ID, and thinking level, as today.
- **Tiered** — the session stores one tier from a strict machine-configured ladder and resolves that tier to an exact tuple before each request.

The fixed ladder is:

```text
Economy → Fast → Standard → Advanced → Capable → Frontier
```

The feature must also provide an opt-in deterministic replacement for the commonly installed global `subagent-driven-development` skill. Plans assign implementation tiers explicitly; the skill dispatches children with absolute `/tier-*` directives, validates requested versus effective policy, and persists legal transitions outside conversational memory. PI WEBUI never disables, moves, overwrites, or installs a user's existing SDD skill automatically.

## Success criteria

1. Each selected machine exposes one complete user-configured six-tier ladder.
2. Exact/Tiered is an independent, always-visible session choice controlled only through the UI.
3. Tier commands act only in Tiered mode and are visible no-ops in Exact mode.
4. A recognized leading directive applies its exact resolved tuple before any subsequent model request.
5. Busy-session directives remain queued and cannot alter in-flight work.
6. Root sessions start Exact; independent and tracked children inherit their parent's complete policy.
7. Child initial directives validate before child creation, so failure leaves no stray child.
8. Requested and effective policy are visible in the child and returned structurally to its parent.
9. Tracked SDD dispatch is idempotent across controller compaction and daemon restart.
10. The replacement SDD skill preserves the original workflow's safety gates except where this specification explicitly replaces a rule.

## Scope

This specification covers:

- per-machine tier mappings in PI WEBUI global config;
- Exact/Tiered policy persistence for all sessions;
- current-session and initial-child tier directives;
- inheritance for `spawn_session` and `spawn_subsession`;
- selected-machine API/session-daemon transport;
- a read-only model-policy inspection tool;
- idempotent tracked-child dispatch;
- starter, active-session, Settings, responsive, and accessibility behavior;
- repository source, optional packaging, collision-safe installation, and manual migration for the deterministic SDD skill;
- documentation, compatibility, tests, and operational restart behavior.

## Non-goals

- Inferring model quality, speed, or cost from provider metadata.
- Automatically classifying tasks into tiers at SDD execution time.
- Project-local tier mappings or one project config file per feature.
- Gateway-wide mappings shared across machines.
- Natural-language detection such as "use a capable model."
- Tier command aliases outside the canonical `/tier-*` family.
- Letting a model-facing command or tool switch Exact/Tiered mode.
- Silently falling back to another model, tier, or thinking level.
- Adding recursive tracked-child delegation.
- Modifying upstream Pi.
- Automatically disabling, moving, uninstalling, overwriting, or shadowing an existing SDD skill.
- Auto-discovering or auto-installing the bundled deterministic SDD merely because PI WEBUI is installed.

## Domain language

### Exact mode

A session mode whose active model is the user's exact provider/model/thinking selection. Tier directives are consumed but cannot alter the selection.

### Tiered mode

A session mode whose active assignment is a tier. The exact tuple is resolved through the selected machine's latest valid ladder at each request boundary.

### Model tier

One member of the fixed ordered ladder. A tier is a policy label, not a model identity.

### Tier mapping

A selected machine's complete mapping from every model tier to one exact tuple.

### Session model policy

A session's active mode plus its remembered Exact selection and, once chosen, its remembered tier.

### Tier directive

One canonical leading `/tier-*` command that selects a tier or moves one rung. It never changes session mode.

### Policy application

The durable result of handling a request: requested directive, outcome, effective mode/tier, and resolved exact tuple.

### Implementer tier

The tier assigned by a reviewed implementation plan to a task's initial implementation role. It anchors deterministic reviewer and fix-round calculations.

## Product decisions

### Exact and Tiered are independent UI choices

Exact/Tiered is an independent first button in the composer status controls. It is not nested inside the model selector, inferred from the current model, or changed by slash commands.

```text
Exact:
[ Exact ▾ ] [ provider / model ▾ ] [ thinking ▾ ]

Tiered:
[ Tiered ▾ ] [ tier ▾ ] [ resolved tuple — read-only ]
```

Mode changes are user-facing UI operations carried over a dedicated server route. No slash command, model-facing tool, or child prompt may invoke that mutation. A model-facing tool can inspect policy but cannot mutate mode.

### Each mode remembers its last valid branch

```ts
interface SessionModelPolicy {
  mode: "exact" | "tiered";
  exact: ExactModelSelection;
  tier?: ModelTier;
}
```

`exact` is always present. `tier` is absent only until the user first chooses one. `mode: "tiered"` requires `tier`.

Switching to a remembered valid branch applies immediately and atomically while the session is idle. First-time Tiered entry opens the tier selector and commits nothing until a valid tier is chosen. Returning to Exact restores the remembered exact tuple.

### Root and child defaults

- A new root session starts Exact for backward compatibility.
- Its exact branch starts from Pi's currently resolved starter model and thinking level.
- Both child tools inherit the parent's complete policy snapshot.
- An Exact child therefore inherits the parent exact tuple and ignores tier directives.
- A Tiered child inherits the parent tier, then may apply a leading tier directive before its first request.
- Fork, clone, resume, and tree navigation derive policy from the active session branch.

### Complete machine-owned ladder

Every machine owns one six-rung ladder in `$PI_WEBUI_CONFIG` or `~/.config/pi-webui/config.json`.

There are no project-local overrides and no gateway-wide cross-machine mapping. Multiple tiers may intentionally map to the same exact tuple.

### Latest mapping applies at request boundaries

A Tiered session persists a tier, not a frozen exact tuple. Before each request, PI WEBUI resolves that tier through the latest machine mapping.

Changing the mapping does not interrupt in-flight work. Existing Tiered sessions adopt it when their next request reaches the boundary. The UI labels the displayed resolution accordingly.

## Domain values and invariants

```ts
type ModelTier =
  | "economy"
  | "fast"
  | "standard"
  | "advanced"
  | "capable"
  | "frontier";

interface ExactModelSelection {
  model: {
    provider: string;
    id: string;
  };
  thinkingLevel: string;
}

type ModelTierLadder = Record<ModelTier, ExactModelSelection>;
```

The following invariants are mandatory:

1. A saved ladder has exactly all six canonical keys.
2. Each tuple resolves to a currently available authenticated model and a thinking level supported by that model at save time.
3. Duplicate tuples across tiers are valid.
4. A Tiered policy always has an assigned tier.
5. Tier directives never change `mode`.
6. Exact directives do not consult or require a valid tier mapping; they record `ignored-exact` and continue under the exact tuple.
7. Tiered requests resolve against the latest mapping before any provider call.
8. Failed resolution changes no policy/runtime state and does not process the request remainder.
9. No provider call observes an intermediate model/thinking pair.
10. A malformed latest policy entry is authoritative failure, not permission to revive older intent.
11. Requested and effective dispatch policy must agree according to mode-specific rules.
12. No audit entry contains credentials, resolved headers, tokens, or provider secrets.

## Per-machine configuration

### Config shape

Add one core key to the existing global PI WEBUI config:

```json
{
  "modelTiers": {
    "economy": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-luna"
      },
      "thinkingLevel": "low"
    },
    "fast": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-luna"
      },
      "thinkingLevel": "medium"
    },
    "standard": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-sol"
      },
      "thinkingLevel": "medium"
    },
    "advanced": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-sol"
      },
      "thinkingLevel": "high"
    },
    "capable": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-sol"
      },
      "thinkingLevel": "xhigh"
    },
    "frontier": {
      "model": {
        "provider": "RightCode-OpenAI",
        "id": "gpt-5.6-sol"
      },
      "thinkingLevel": "max"
    }
  }
}
```

PI WEBUI preserves unrelated config keys when replacing the ladder.

### Missing or externally invalid configuration

A missing or incomplete ladder means Tiered mode is unavailable. Exact sessions remain usable.

If a model becomes unavailable after save, PI WEBUI retains the configured value and marks it unavailable. It does not silently delete or rewrite the user's configuration. Tiered requests targeting it fail closed until repaired.

An externally edited malformed ladder produces an actionable configuration error. The last in-memory valid mapping must not be silently treated as the current file intent after a confirmed invalid edit.

## User experience

### Settings navigation

Add a dedicated settings section:

```text
Model tiers
Selected machine
```

Do not place tier mapping in the Models dialog or Session daemon panel:

- Models continues to own provider/model definitions in `models.json`.
- Session daemon continues to own runtime enablement and restart-sensitive profile fields.
- Model tiers owns PI WEBUI routing policy in global PI WEBUI config.

### Approved ladder editor

Use an ordered comparison table:

```text
      Tier       Available model                    Thinking
  1   Economy    [ provider / model             ▾ ] [ low    ▾ ]
  ↓   Fast       [ provider / model             ▾ ] [ medium ▾ ]
  ↓   Standard   [ provider / model             ▾ ] [ medium ▾ ]
  ↓   Advanced   [ provider / model             ▾ ] [ high   ▾ ]
  ↓   Capable    [ provider / model             ▾ ] [ xhigh  ▾ ]
  6   Frontier   [ provider / model             ▾ ] [ max    ▾ ]
```

Behavior:

- Model choices come only from the selected machine's current available snapshot.
- Selecting a model updates the thinking selector to that model's supported levels.
- Changing to a model that cannot support the draft thinking level makes that row incomplete; it does not clamp silently.
- Save is enabled only when all six rows are valid.
- Save writes and validates the complete ladder atomically.
- A stale configured model remains visibly selectable only as the current invalid value, with available replacements offered.
- A stale response from a previously selected machine cannot overwrite the current draft.
- On narrow screens, each row becomes a compact card while preserving ladder order.

### Starter composer

A new root starter displays the independent mode button first and starts Exact.

Exact starter controls preserve the current model/thinking behavior. Confirmed model selection, model cycling, thinking selection, and thinking cycling update the remembered Exact branch with Pi's actual effective pair. Selecting Tiered for the first time immediately opens the tier selector; Start remains unavailable until the tier is valid. The starter retains both branches while the user edits the prompt or attachments.

### Active composer

Exact:

```text
[ Exact ▾ ] [ RightCode-OpenAI / gpt-5.6-sol ▾ ] [ high ▾ ]
```

Tiered:

```text
[ Tiered ▾ ] [ Advanced ▾ ] [ → gpt-5.6-sol · high ]
```

The mode button is always first and always visible. The Tiered resolution is read-only. Full provider/model/thinking text remains available through accessible text and a title when abbreviated.

While agent, bash, compaction, tree-exclusive, queued, or session-entry mutation work is active, policy controls remain inspectable but disabled. Tier directives submitted during work use the queue semantics below instead of the UI mutation path.

Archived sessions are read-only.

### Mode-button interaction

When both remembered branches remain valid, choosing the other mode applies immediately and atomically. There is no confirmation dialog and no separate Apply step.

If the destination branch is absent or stale:

- first-time Tiered opens the tier chooser and commits only after a valid selection;
- stale Exact opens exact model/thinking repair and leaves the current mode unchanged until valid;
- cancel leaves policy unchanged.

## Canonical tier commands

```text
/tier-economy
/tier-fast
/tier-standard
/tier-advanced
/tier-capable
/tier-frontier
/tier-up
/tier-down
```

No aliases are added. Grouping under `/tier-` keeps autocomplete and skill generation deterministic.

### Recognition

A directive is recognized only as the first non-whitespace token. It may be standalone or precede the request on the same or next line.

Recognized:

```text
/tier-capable
/tier-capable implement task X
/tier-capable
implement task X
```

Not recognized:

```text
Please use /tier-capable for this task.
`/tier-capable`
The string "/tier-capable" appears in a file.
```

Canonical names are lowercase. At most one leading tier directive is accepted. Multiple leading tier directives are malformed and produce no partial transition.

Attachments remain attached to the cleaned remainder. A directive with neither text remainder nor attachments performs no LLM call; attachments by themselves count as request content and run after the policy transition.

### Direct selection

In Tiered mode, `/tier-capable` selects Capable. Selecting the already assigned tier records `tier-unchanged` and still processes any cleaned remainder. The request nevertheless resolves the latest mapping, so the exact runtime tuple may change even when the tier label does not.

In Exact mode, every direct selection records `ignored-exact`, leaves the exact tuple unchanged, and processes any cleaned remainder.

### Relative selection

`/tier-up` moves exactly one rung:

```text
Economy  → Fast
Fast     → Standard
Standard → Advanced
Advanced → Capable
Capable  → Frontier
Frontier → unchanged: already at maximum
```

`/tier-down` is the exact inverse. Economy remains unchanged at the minimum.

Relative directives are user conveniences. The deterministic SDD skill never emits them.

### Busy input

A leading tier directive submitted while the session is busy is queued as one intact follow-up with its remainder and attachments. It cannot steer or alter the current run. Directive parsing and policy application happen only when that queued input reaches the request boundary.

## Atomic request processing

All active request paths cross one policy-processing seam:

```text
receive raw request
→ queue intact when busy
→ parse at most one leading directive
→ inspect active-branch policy
→ compute candidate policy
→ resolve latest machine mapping when Tiered
→ validate model availability, auth, and thinking support
→ apply model + thinking + policy under serialized session mutation
→ append durable application event
→ publish one confirmed combined status
→ process only the cleaned remainder
```

Atomicity is defined at the agent/request interface:

- no provider call begins before the complete target tuple is active;
- no combined status reports success before model, thinking, and policy persistence succeed;
- validation failure leaves the previous state untouched;
- unexpected apply/persistence failure attempts restoration of the previous exact runtime tuple;
- if restoration cannot be proven, the session enters `MODEL_POLICY_BLOCKED` and refuses prompts rather than running ambiguously.

The runtime adapter may internally cross Pi's separate model/thinking setters, but intermediate state is not observable to an agent request or published as a confirmed policy application.

## Policy persistence and audit

### Policy entry

Persist a versioned custom entry outside LLM context:

```text
customType: pi-webui.model-policy
```

It stores:

```text
version
active mode
remembered exact tuple
remembered tier, when one exists
```

Reads inspect the active branch. The latest matching entry is authoritative. A malformed or unsupported latest entry fails closed; no older value or runtime fallback replaces it silently.

A legacy session with no matching entry derives:

```text
mode: Exact
exact: current resolved runtime model + thinking
remembered tier: unset
```

### Application entry

Persist each tier-directive or UI-policy application as:

```text
customType: pi-webui.model-policy-application
```

Conceptual value:

```ts
interface ModelPolicyApplication {
  requestedDirective?: string;
  outcome:
    | "directive-applied"
    | "ignored-exact"
    | "tier-unchanged"
    | "mapping-updated"
    | "ui-applied"
    | "rejected";
  mode: "exact" | "tiered";
  tier?: ModelTier;
  resolved: ExactModelSelection;
  at: string;
  error?: {
    code: string;
    message: string;
  };
}
```

A rejected active-session directive appends a safe `rejected` application event, leaves policy/runtime state unchanged, and does not process the remainder. A child-start rejection has no child transcript because no child exists; the parent receives the same canonical rejection details as the spawn error.

A Tiered request without a directive appends `mapping-updated` only when latest mapping resolution changes the exact runtime tuple. Requests whose tier and exact tuple are already current do not add a redundant application entry.

### Human rendering

Tiered child:

```text
Tier applied: Capable → RightCode-OpenAI/gpt-5.6-sol · high
```

Exact child:

```text
Tier directive ignored: Exact → RightCode-OpenAI/gpt-5.6-sol · high
```

The child entry appears before the cleaned user task and remains outside child LLM context.

### Parent result

`spawn_session` and `spawn_subsession` return the same canonical policy application in structured details. Parent-facing text includes requested tier, outcome, and exact resolved tuple.

The SDD controller writes requested and effective values into `state.json` and `progress.md`. In Tiered mode, the effective tier must match the requested absolute tier. In Exact mode, `ignored-exact` with the inherited exact tuple is expected. Any other mismatch is blocking.

## Child startup

Both child types use this sequence:

```text
inherit complete parent policy
→ parse the initial prompt's leading directive
→ resolve and validate effective policy
→ if invalid, return error without creating a child
→ create child runtime directly with resolved model + thinking
→ persist inherited/effective policy and application entry
→ append cleaned user task
→ start the agent run
```

This preserves the atomic first-request guarantee and prevents failed directives from leaving idle stray children.

Tracked children retain existing lineage, same-project workspace validation, completion notification, transcript inspection, unread behavior, and recursive tracked-delegation suppression.

## Idempotent tracked dispatch

### Public field

Add an optional bounded `dispatchKey` to `spawn_subsession`.

The deterministic SDD writes its dispatch intent before invoking the tool and derives a key from stable state, for example:

```text
<plan-digest>:task-4:review:attempt-1
```

### Semantics

The idempotency scope is parent identity plus dispatch key.

On the first request, the daemon stores:

```text
parent identity
dispatch key
canonical caller inputs: cwd + raw prompt
request fingerprint
child session ID
confirmed model-policy application
```

A retry performs idempotency lookup before re-reading the parent's current policy or latest ladder:

- same key and same canonical caller inputs return the original child and original policy application;
- same key with different cwd or raw prompt fails as conflicting reuse;
- a changed parent policy or ladder after the first successful call does not retroactively change the original dispatch result.

The registry survives session-daemon restart. Records live in PI WEBUI-managed state under `$PI_WEBUI_DATA_DIR`, not user config, and contain no secrets. They remain while the parent/child lineage remains addressable and are removed with permanent session cleanup; archive/restore does not discard them.

### Recovery

If SDD state contains a dispatch intent but no child ID after compaction/crash, the controller repeats the same spawn call. It receives the existing child rather than creating a duplicate.

## Architecture

### Authority

The long-lived session daemon owns tier validation, policy persistence, directive processing, runtime application, child inheritance, audit construction, and tracked dispatch idempotency.

The web/API process is a transport adapter. The browser owns drafts and confirmed display state only. Browser or web/API restart cannot alter active session policy.

### ModelTierRegistry module

A deep `ModelTierRegistry` module hides config-file access, live model-catalog refresh, supported-thinking projection, complete-ladder validation, external-edit detection, and exact tier resolution.

Conceptual interface:

```ts
interface ModelTierRegistry {
  inspect(): Promise<ModelTierConfigurationSnapshot>;
  replace(ladder: ModelTierLadder): Promise<ModelTierConfigurationSnapshot>;
  resolve(tier: ModelTier): Promise<ResolvedModelSelection>;
}
```

The module:

- reads/writes only `modelTiers` while preserving other global config;
- uses an injected model runtime/catalog;
- refreshes without network discovery at request/save boundaries;
- writes one complete ladder atomically;
- detects external file revision/hash changes;
- exposes invalid intent instead of silently retaining stale valid state.

### SessionModelPolicy module

A deep `SessionModelPolicy` module hides custom-entry formats, branch lookup, legacy derivation, directive parsing, mode/tier transitions, child inheritance, and audit construction.

Conceptual pure operations:

```ts
inspectSession(branch, runtimeSelection): PolicyInspection;
parseDirective(rawInput): ParsedPolicyInput;
planRequest(policy, parsedInput, ladder): PolicyApplicationPlan;
planUiTransition(policy, request, ladder): PolicyApplicationPlan;
inheritForChild(parentPolicy): SessionModelPolicy;
```

A plan carries all values the effectful runtime adapter needs:

```ts
interface PolicyApplicationPlan {
  nextPolicy: SessionModelPolicy;
  resolved: ExactModelSelection;
  cleanedPrompt: string;
  audit: ModelPolicyApplication;
}
```

### Runtime adapter

One thin adapter consumes a validated application plan and owns serialized model/thinking application, restoration, custom-entry append, and combined status publication.

No route, command, or child-spawn caller independently sequences `setModel`, `setThinkingLevel`, and policy persistence.

### Browser modules

Add focused modules such as:

```text
SettingsModelTiersPanel
modelTierLadderDraft
SessionModelPolicyControl
sessionModelPolicyDraft
```

`PromptEditor` remains layout glue. Pure draft modules own model/thinking compatibility, remembered-branch transitions, and validation. Session/app controllers own transport and stale-response guards.

## Transport and capabilities

### Machine capability

Advertise an additive capability:

```text
sessions.modelPolicy
```

The effective capability is present only when web/API and session-daemon peers support the required contract. Older peers omit it.

### Machine tier routes

```text
GET api/machines/:machineId/model-tiers
PUT api/machines/:machineId/model-tiers
```

GET returns:

- saved ladder, including stale values;
- current available models;
- supported thinking levels;
- row validation;
- contract version.

PUT accepts one complete ladder, validates against the selected daemon's catalog, writes the global config key, and returns the confirmed snapshot.

### Active session routes

```text
GET api/.../sessions/:sessionId/model-policy
PUT api/.../sessions/:sessionId/model-policy
```

PUT accepts one complete UI-authorized policy transition. It is the only interface that changes Exact/Tiered mode.

Existing exact model/thinking set and cycle routes update the remembered Exact branch only while Exact is active, using Pi's confirmed effective pair after its ordinary model-capability handling. They reject direct mutation while Tiered is active rather than creating state the next request would overwrite. Tier mappings themselves never clamp unsupported thinking levels.

### Session status

Add optional policy status:

```ts
interface ClientSessionModelPolicyStatus {
  mode: "exact" | "tiered";
  tier?: ModelTier;
  resolved: ExactModelSelection;
  ladderValid: boolean;
  blockedReason?: string;
}
```

Omission means the peer does not support the feature, not an empty policy.

### Read-only model-facing tool

Register `get_model_policy` with no parameters and no mutation authority. It returns:

```text
contract version
active mode
remembered/current tier
current runtime tuple
next-request resolved tuple
ladder validity
supported tier-command contract
idempotent tracked-dispatch contract
```

In Exact mode, an invalid/missing ladder does not block SDD because child tier directives are expected no-ops. In Tiered mode, invalid ladder state is capability-blocking.

### Command listing

Expose only the eight canonical tier commands through the existing command list/autocomplete path. Built-in PI WEBUI command handling owns these names before runtime extension commands.

## Deterministic SDD replacement

### Repository source and installation identity

The version-controlled source of truth lives at a non-auto-discovered project path:

```text
optional-skills/subagent-driven-development/
```

Its skill frontmatter retains the canonical name `subagent-driven-development`. When a user opts in, the installed copy lives under the target Pi agent profile at:

```text
<agent-dir>/skills/subagent-driven-development/SKILL.md
```

For the ordinary profile this is `~/.pi/agent/skills/subagent-driven-development/SKILL.md`.

The repository source is not listed under `package.json` `pi.skills`, and installing PI WEBUI never activates it automatically.

### Package structure

```text
optional-skills/
└── subagent-driven-development/
    ├── SKILL.md
    ├── references/
    │   ├── state-machine.md
    │   └── plan-contract.md
    ├── prompts/
    │   ├── implementer.md
    │   ├── task-reviewer.md
    │   ├── re-reviewer.md
    │   └── final-reviewer.md
    ├── scripts/
    │   ├── sdd-state
    │   ├── sdd-workspace
    │   ├── task-brief
    │   └── review-package
    ├── pi-webui-skill.json
    ├── tests/
    │   └── sdd-state.test.mjs
    └── evals/
        └── pressure-scenarios.md
```

`SKILL.md` stays concise. The exhaustive transition table and plan schema live in focused references. Mechanical constraints live in `sdd-state` and its tests.

### Opt-in installer

Ship the optional runtime payload in the npm package only after the model-policy command contract is implemented. The repository keeps tests/evals beside the source, but the package allowlist and installer copy only `SKILL.md`, runtime references/prompts/scripts, and the ownership manifest. Provide an explicit command such as:

```text
pi-webui skill install subagent-driven-development
```

The command runs on the target machine and resolves the intended Pi agent profile, with an explicit profile/agent-directory override when needed.

Installer behavior is fail-safe:

1. If no canonical target exists and no effective same-name global skill conflicts, stage and atomically copy the bundled skill.
2. If the target already contains the same PI WEBUI-owned version and checksum, report `already installed` without rewriting it.
3. If any unknown/original same-name skill occupies the target or another effective global source, stop before mutation and report every discovered source.
4. Never change `disable-model-invocation`, move a directory, uninstall a package, overwrite files, or choose which existing skill the user meant to replace.
5. Tell the user how to manually archive, uninstall, or otherwise remove/disable the original source, then rerun the installer.
6. After install, verify the installed tree against the bundled manifest/checksum and instruct the user to run `/reload` in each idle target session.

The installed copy is a deployment artifact; repository source remains authoritative. A bundled ownership manifest records package version and source-tree checksum so later status/update tooling can distinguish PI WEBUI's copy from an unrelated original.

### Plan contract

Every executable task uses a contiguous second-level heading and explicit tier:

```md
## Task 3: Apply model policy at request boundaries

**Implementer tier:** Advanced
```

Preflight rejects missing/unknown tiers, duplicate or non-contiguous task numbering, changed plan identity, and contradictions requiring human resolution. The controller never classifies task complexity during execution.

### Tier formulas

```text
Initial implementer:
  plan Implementer tier

Task reviewer:
  one rung above Implementer tier
  Standard floor, Frontier cap

Fixer:
  rounds 1–3 → Implementer tier
  round 4     → Implementer tier + 1
  round 5     → Implementer tier + 2
  Frontier cap

Scoped re-reviewer:
  one rung above current fixer
  Standard floor, Frontier cap

Final whole-branch reviewer:
  Frontier

Single final-fix wave:
  Frontier

Final scoped re-review:
  Frontier
```

The controller always emits the calculated absolute `/tier-*` command. It never emits `/tier-up` or `/tier-down`.

### Capability preflight

The skill requires compatible `get_model_policy` and idempotent `spawn_subsession` contracts.

Outcomes:

- missing/incompatible contract → `CAPABILITY_BLOCKED`;
- Tiered with invalid ladder → `CAPABILITY_BLOCKED`;
- Exact with valid exact selection → proceed, recording that directives should be ignored;
- ambiguous/blocked session policy → `CAPABILITY_BLOCKED`.

### Canonical state

Each plan owns its existing isolated workspace under:

```text
<repo>/.superpowers/sdd/<plan-slug>/
```

`state.json` is canonical and includes:

```text
schema version and monotonic revision
plan path + digest
repository/worktree/branch/merge-base identity
phase
task number + Implementer tier
context-attempt and fix-round counts
requested tier and expected outcome
dispatch key and child session ID
effective mode/tier/exact tuple
base/head commit ranges
open/deferred/parked findings
last validated transition
terminal reason
```

`progress.md` is an append-only human projection.

The state helper:

- validates legal transitions;
- requires the caller's expected revision;
- writes state through temp file plus atomic rename;
- stores the complete latest transition so a missing audit line can be backfilled;
- rejects plan/worktree identity drift;
- never spawns or reviews by itself.

### Dispatch intent

Before every tracked child spawn, state records:

```text
dispatch key
role
task
attempt or round
requested tier
prompt/brief/report paths
```

If state recovery finds intent without a child ID, the controller repeats the same idempotent tool call.

After spawn, the controller validates requested versus effective application and records the child ID and exact tuple. Expected Exact `ignored-exact` is accepted. Any unexplained mismatch enters `DISPATCH_MISMATCH_BLOCKED`.

### Task state machine

```text
CAPABILITY_CHECK
→ PLAN_VALIDATE
→ PREFLIGHT_DECISION_REQUIRED, when human plan resolution is needed
→ WORKSPACE_READY
→ IMPLEMENT_DISPATCH_INTENT
→ IMPLEMENT_RUNNING
→ IMPLEMENT_RESULT
→ TASK_REVIEW_DISPATCH_INTENT
→ TASK_REVIEW_RUNNING
→ TASK_REVIEW_DECISION
```

Implementer statuses remain:

```text
DONE
DONE_WITH_CONCERNS
NEEDS_CONTEXT
BLOCKED
```

- DONE proceeds to independent review.
- DONE_WITH_CONCERNS is classified before review: observational concerns are carried explicitly into the gate; correctness, scope, or completeness doubts enter `CONCERN_DECISION_REQUIRED` and review cannot begin until resolved.
- NEEDS_CONTEXT enters `CONTEXT_REQUIRED`.
- BLOCKED enters `TASK_BLOCKED`; the controller does not force a blind retry.

At most two context-enriched fresh re-dispatches are allowed at the same planned tier. A third NEEDS_CONTEXT enters TASK_BLOCKED. These attempts do not consume fix rounds because no reviewed implementation exists.

### Review and fix machine

Every task review must return both:

```text
spec compliance: pass
quality: approved
```

Critical/Important issues, spec failures, and controller-confirmed real gaps enter the bounded fix loop.

Each fix round uses a fresh child with task brief, persistent report, exact open findings, relevant tests, and scoped diff package. Every fix is followed by a fresh scoped re-review.

Five rounds are the hard cap. At round five:

- contestable or non-load-bearing residuals may be parked only with an explicit ruling;
- load-bearing residuals enter TASK_BLOCKED;
- silent dismissal is impossible.

Minor and out-of-scope observations remain visible to the final review.

### Final review

After all tasks complete:

```text
FINAL_REVIEW_RUNNING
→ COMPLETE
```

or:

```text
FINAL_REVIEW_RUNNING
→ FINAL_FIX_RUNNING
→ FINAL_REREVIEW_RUNNING
→ COMPLETE | FINAL_BLOCKED
```

There is exactly one consolidated final-fix wave. COMPLETE hands off to `finishing-a-development-branch` only after final review.

### Original safety preservation

Every original SDD safety rule remains mandatory unless this specification explicitly replaces it.

Preserved rules include:

- dedicated worktree with a checked-out branch;
- per-plan recovery workspace;
- batched plan preflight;
- one SDD-owned child active at a time and no parallel implementation tasks;
- task briefs and file-based reports;
- implementer TDD evidence and self-review;
- independent spec-and-quality task review;
- scoped re-review after every fix;
- plan-conflict routing to the human partner;
- deferred-minor and cannot-verify resolution;
- bounded breaker adjudication;
- Frontier whole-branch review;
- one final fix wave;
- continuous execution except at explicit blocked/decision states.

Approved replacements are:

- plan-declared Implementer tiers instead of runtime model judgment;
- fresh fix children at every round;
- validated state plus audit instead of Markdown-only recovery;
- capability gating;
- absolute tier directives;
- deterministic reviewer/fix escalation;
- a two-attempt context limit;
- explicit TASK_BLOCKED handling instead of controller-invented capability retries after a child reports BLOCKED;
- idempotent dispatch and requested/effective verification.

## Error handling

### Missing ladder

Tiered cannot be selected. Exact remains available. A Tiered session restored against missing config is blocked before its next request and shows an actionable repair message.

### Removed authentication or model

Tier resolution fails with exact provider/model/tier details. The prior session policy/runtime tuple remains. The request remainder does not run.

### Unsupported thinking level

Save or request application fails; no clamping occurs in tier mapping. Settings retains the attempted row for correction.

### Busy UI mutation

Mode/model/tier controls are disabled. A stale forged request remains subject to server-side active-work guards.

### Policy persistence failure

The runtime adapter restores the previous tuple. If it cannot prove restoration, it marks the session blocked and publishes the failure.

### Idempotency conflict

Same key with changed canonical caller inputs fails and creates no child. It never guesses which request owns the key.

### Corrupt SDD state

`sdd-state` refuses transitions and reports the exact invalid field/revision. The controller does not reconstruct canonical state from memory. Recovery uses Git, reports, audit, and the explicit repair procedure.

### Plan changed after start

Digest mismatch blocks execution. A human-approved state migration or a new plan workspace is required; the controller cannot silently adopt changed tasks.

## Security properties

- Tier mapping selects only already available authenticated models from the target daemon.
- Provider and model ID remain separate bounded strings; model IDs may contain `/`.
- No arbitrary endpoints, keys, headers, or credentials enter tier config routes beyond existing model configuration.
- Policy and application entries contain identities and thinking levels only.
- Child workspace validation remains same-project and server-authoritative.
- Dispatch keys are bounded, scoped to a parent, and never accepted as cross-parent references.
- Idempotency conflict checks use canonical fields and do not leak another parent's child.
- Model-facing inspection is read-only.
- Tier commands cannot opt an Exact user into Tiered spending.

## Verification strategy

Follow repository TDD and testing guidance. Use the smallest layer that proves each behavior, then broad verification.

### Skill RED/GREEN/REFACTOR

Before writing the replacement skill, run two baselines:

- pressure scenarios with the original skill, to capture how it fails the new deterministic requirements;
- no-guidance controls, to prove each behavior-shaping wording test has a real failure to correct.

Capture failures including:

1. Guessing tiers for an unannotated plan.
2. Dispatching without capability preflight.
3. Losing child identity between spawn and ledger update.
4. Assuming a tier applied in Exact mode.
5. Continuing after requested/effective mismatch.
6. Repeating NEEDS_CONTEXT without a bound.
7. Inventing an illegal transition after compaction.
8. Dropping deferred or parked findings.

Then:

- unit-test state transitions and tier formulas;
- test expected-revision compare-and-swap;
- test plan/worktree digest checks;
- test atomic state replacement and audit backfill;
- test dispatch-intent recovery with a fake idempotent spawn;
- run the same pressure scenarios with the replacement;
- micro-test behavior-shaping wording against a no-guidance control with at least five fresh-context repetitions per variant;
- add rationalization counters only for failures observed;
- re-test until behavior converges.

### Tier-registry tests

1. Parse/serialize exactly six tiers.
2. Reject missing, extra, malformed, blank, or oversized fields.
3. Accept duplicate exact tuples.
4. Project available models and supported thinking levels.
5. Reject unavailable models and unsupported thinking.
6. Preserve stale configured intent visibly.
7. Detect external config revision changes.
8. Preserve unrelated global config keys on atomic replacement.

### Policy pure tests

1. Legacy session derives Exact.
2. Exact/Tiered remembers both branches.
3. First Tiered entry requires a tier.
4. Commands cannot change mode.
5. Leading-only parse accepts same-line/newline remainder.
6. Prose/code mentions do not trigger.
7. Multiple directives reject without partial application.
8. Direct and relative transitions follow the strict ladder.
9. Exact records ignored and retains its tuple.
10. Tiered resolves latest mapping.
11. Boundary commands record `tier-unchanged` while still resolving the latest exact tuple.
12. Requested/effective audit values are complete.
13. Active-branch malformed latest entry fails closed.

### Runtime/session tests

1. Model and thinking apply before any provider request.
2. Validation failure changes nothing.
3. Persistence/apply failure restores previous selection.
4. Failed restoration enters MODEL_POLICY_BLOCKED.
5. Busy directives remain queued intact.
6. Exact model/thinking set and cycle routes update remembered Exact only in Exact mode.
7. UI mode switch applies a complete policy.
8. Resume/fork/clone/tree navigation use active-branch policy.
9. Mapping changes apply at next request boundary, not mid-run.

### Child and idempotency tests

1. Both child types inherit full policy.
2. Initial directive validates before child creation.
3. Invalid target creates no child.
4. Child event precedes cleaned user task and stays out of LLM context.
5. Parent result and child entry project one canonical application.
6. Same tracked dispatch key/request returns one child.
7. Conflicting key reuse fails.
8. Dedup survives daemon recreation.
9. Retry lookup returns original outcome despite later mapping/policy changes.
10. Existing lineage, completion, transcript, workspace, and recursion rules remain green.

### Route/protocol tests

1. Machine-tier GET/PUT uses the selected daemon catalog.
2. Session policy GET/PUT validates complete transitions.
3. Canonical commands appear in autocomplete.
4. Older peers safely omit capability and fields.
5. Remote forwarding preserves machine identity.
6. Application-relative browser URL conventions remain intact.
7. `get_model_policy` is read-only and contract-versioned.

### Installer and package tests

1. Bundled optional source is absent from Pi auto-discovery metadata.
2. An empty temporary agent profile installs atomically and verifies its manifest/checksum.
3. An identical PI WEBUI-owned copy returns already-installed without rewriting files.
4. An unknown/original canonical target causes a no-mutation refusal with actionable source details.
5. Another effective global same-name source causes the same refusal.
6. Explicit target profile/agent directory is honored; the installer never writes to a fallback profile silently.
7. Interrupted staging leaves the previous target intact and cleans or reports temporary state.
8. `npm pack --dry-run` includes the runtime payload under `optional-skills/subagent-driven-development/` only after the command capability is shipped, and excludes repository-only tests/evals.
9. Package metadata does not list the optional skill under `pi.skills`.
10. README commands and detailed rollback instructions match actual CLI behavior.

### Client/component tests

1. Dedicated settings navigation and ordered six-row editor.
2. Model selection constrains thinking options.
3. Atomic complete save and stale-row repair.
4. Independent Exact/Tiered first button.
5. Exact and Tiered expose the correct independent secondary controls.
6. Remembered branch restoration and first-tier requirement.
7. Busy/archived disabled-but-inspectable behavior.
8. Selected-machine stale response guards.
9. Real DOM keyboard/focus/accessibility behavior.
10. Responsive labels preserve full accessible information.

Use TemplateResult handler extraction only for narrow wiring tests where the repository guide permits it. Layout itself requires visual/manual or screenshot validation, not TemplateResult assertions.

### Broad verification

Run focused tests first, then:

```text
npm run typecheck
npm run lint
npm run knip
npm test
git diff --check
npm run verify
```

## Implementation-plan decomposition

This is one program-level contract because the replacement skill and PI WEBUI command capability must agree exactly, but it is intentionally too large for one execution plan.

Create and execute plans in this order:

1. **Plan A — deterministic SDD source:** skill pressure tests, state helper, committed optional source, and isolated explicit-path verification of CAPABILITY_BLOCKED; no installed skill is modified.
2. **Plan B — command/policy core:** tier registry, session policy, atomic request processing, child inheritance, audit, idempotency, daemon transport, and backend integration tests.
3. **Plan C — Settings/UI and end-to-end activation:** approved controls, selected-machine UI, client compatibility, documentation, Changeset, and complete SDD E2E verification.

Only Plan A is written after this specification's review. Plan B begins only after Plan A's source/test verification gate passes; Plan C begins only after the backend command contract passes focused integration verification.

## Rollout

### Phase A — replacement skill source before product code

1. Run original-skill and no-guidance baseline pressure tests without modifying the installed original.
2. Implement/test the state helper and replacement under `optional-skills/subagent-driven-development/`.
3. Run skill GREEN/REFACTOR tests with fake model-policy and idempotent-spawn contracts.
4. Load the source explicitly in an isolated test profile/session that does not discover the original.
5. Verify deterministic CAPABILITY_BLOCKED before product support exists.
6. Verify the user's installed/discovered original skill remains byte-for-byte unchanged and usable.

There is no forced SDD outage and no automatic global installation in Phase A.

### Phase B — command, policy, daemon, and idempotency core

Implement production behavior through TDD in a new dedicated worktree based on current main. After installation, manually restart `pi-webui-sessiond.service` once.

Verify command/policy behavior through API and child integration before UI implementation.

### Phase C — Settings, session UI, and optional distribution

Implement the approved dedicated Model tiers page and independent mode/model-or-tier controls through pure draft and real-DOM tests. Add the collision-safe installer, include only the runtime subset of `optional-skills/subagent-driven-development/` in the npm package allowlist without registering it in `pi.skills`, and add concise README plus canonical detailed documentation.

### Phase D — end-to-end SDD verification and user-controlled activation

Run the repository source explicitly against a small tier-annotated plan in both Tiered and Exact modes. Verify idempotent recovery, requested/effective audit, reviewer/fix tier formulas, final review, and finishing handoff.

Test installation in a temporary agent profile for absent, already-owned, and conflicting-original cases. Do not alter the user's real original skill. After all product and installer gates pass, the user may manually disable/remove their original and invoke the installer when they choose.

## Superseded exact-subsessions work

The paused `feature/exact-subsession-model-thinking-selection` worktree implements a narrower policy that explicitly rejects tiers. Do not resume it as the implementation branch and do not merge/cherry-pick it wholesale.

Preserve it unchanged until the new implementation plan audits reusable concepts, especially:

- exact model/thinking value types and validation;
- initial thinking-level runtime plumbing;
- active-branch custom-entry handling;
- selected-machine model option projection;
- fail-closed patterns and tests.

Create the new product implementation in a fresh dedicated worktree from current main. Port only reviewed pieces under the new TDD sequence. Remove the old worktree only during final cleanup after proving no unique work remains.

## Documentation, operations, and release

Update canonical user documentation in both `docs/config.md` and `docs/config.html` with:

- machine ladder configuration;
- Exact/Tiered behavior;
- the eight canonical commands;
- request-boundary and busy-queue semantics;
- root/child inheritance;
- visible audit outcomes;
- stale model/auth failures;
- live mapping reload behavior.

Add a concise README section titled along the lines of **Optional deterministic SDD skill**. It must state that PI WEBUI does not install or disable skills automatically, show the explicit installer command, explain refusal on collision, and link to the canonical detailed migration instructions.

Update `docs/config.md` and `docs/config.html` with source-specific opt-in guidance:

- run installation on the target machine/profile;
- inspect every conflicting skill source reported by the installer;
- manually archive a standalone original or disable/uninstall the package that supplies it;
- explain that `disable-model-invocation: true` alone does not resolve a same-name command/discovery collision;
- rerun install, verify checksum/status, and `/reload` idle sessions;
- document rollback by removing the PI WEBUI-owned installed copy and restoring/re-enabling the original.

Keep this migration detail out of the README beyond the shortest safe path and canonical link.

Production implementation is a backward-compatible user-visible feature and needs one patch Changeset. Do not edit `CHANGELOG.md` manually.

The design/glossary/supersession documentation commit itself is internal and needs no Changeset.

Implementation changes affect session-daemon-loaded code and protocol. Inform the user that `pi-webui-sessiond.service` needs a manual restart after the new code is installed. Ordinary ladder and policy edits then apply live without restart.

## Alternatives considered

### Natural-language routing

Rejected. Phrases such as "use a capable model" are ambiguous, can appear in quoted content, and cannot guarantee request-boundary ordering.

### Exact/Tiered nested inside a model dialog

Rejected by the user. Exact/Tiered must be an independent always-visible choice button, separate from the exact-model or tier selector.

### Permanent separate mode toggle plus hidden policy

Rejected. Mode must be visible, but the control remains a deliberate choice button rather than an accidental one-click toggle.

### Partial tier ladders

Rejected. Missing rungs make one-step relative movement non-total. All six mappings are required; duplicates provide flexibility without holes.

### Gateway or project mappings

Rejected. Model catalogs and credentials are machine-specific; project overrides would fragment the canonical ladder.

### Snapshotting Tiered sessions to exact tuples

Rejected. The tier is the durable assignment; the latest machine mapping intentionally governs the next request.

### Tier commands changing Exact to Tiered

Rejected. Exact is an explicit user sovereignty boundary. Commands are visible no-ops there.

### Commands recognized anywhere in prose

Rejected. Only one canonical leading directive is deterministic and injection-resistant.

### Relative directives in SDD

Rejected. Their outcome depends on inherited/current tier. SDD computes and emits an absolute target.

### Runtime task classification in SDD

Rejected. Reviewed plans declare Implementer tier; execution never guesses.

### Markdown-only recovery

Rejected. Free-form ledger parsing is vulnerable to compaction and formatting drift. Canonical validated state plus an audit projection is stronger.

### Resuming fix children

Rejected for current scope. Existing tracked tools cannot prompt an idle child. Fresh fixers with persistent file handoff avoid adding an unrelated continuation tool.

### Non-idempotent child recovery

Rejected. A state write cannot close the spawn/result crash window without server-supported dispatch idempotency.

### Automatically disabling or replacing an original SDD

Rejected by the user. PI WEBUI must never decide which existing same-name skill to move, disable, uninstall, or overwrite. The installer stops on collision and leaves manual migration to the user.

### Auto-discovering the bundled skill

Rejected. The package ships the source as an optional asset but does not declare it in `pi.skills`; installing PI WEBUI alone cannot shadow an existing workflow.

### Implementing commands before authoring the replacement source

Rejected by the user's rollout decision. The replacement source and state machine are pressure-tested first through an isolated explicit path, but global installation remains opt-in and is not performed before product capability exists.

## Expected implementation areas

Production work is expected to touch focused areas including:

- `src/shared/apiTypes.ts` and capability types;
- `src/config.ts` and selected-machine config parsing;
- focused server model-tier and session-policy modules;
- `src/server/sessions/sessionCommandService.ts` and built-in command listing;
- `src/server/sessions/piSessionService.ts` runtime/start/prompt orchestration;
- `src/server/sessions/spawnSessionTool.ts` and `spawnSubsessionTool.ts`;
- session routes, session-daemon protocol/client, proxy allowlists, and capabilities;
- client API parsers/clients and session controller;
- Settings routing and a focused Model tiers panel;
- `PromptEditor` layout plus a focused session model-policy control;
- paired configuration documentation and one patch Changeset;
- `optional-skills/subagent-driven-development/` and its isolated tests/evals;
- collision-safe CLI installer/status behavior and package allowlisting;
- concise README opt-in instructions plus canonical detailed migration documentation.

Exact file/task boundaries belong in the implementation plan after written-spec review.
