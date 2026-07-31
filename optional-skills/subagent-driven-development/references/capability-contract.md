# Version-1 Capability and Spawn-Result Contract

This file is the canonical handoff to the backend plan that implements these
capabilities. It is frozen at version 1: every later task validates against the
shapes defined here rather than against a live backend.

This reference is **not** loaded into no-guidance or original-skill evaluation
controls. It describes tool contracts, not controller procedure.

Wire tiers are lowercase. Plan documents keep title case (`**Implementer tier:**
Capable`). Canonical order is Economy, Fast, Standard, Advanced, Capable,
Frontier.

## `get_model_policy`

A zero-parameter, read-only tool. It never mutates policy, never applies a tier,
and never returns credentials or endpoints.

```ts
type ModelTier = "economy" | "fast" | "standard" | "advanced" | "capable" | "frontier";

interface ExactModelSelection {
  model: { provider: string; id: string };
  thinkingLevel: string;
}

interface GetModelPolicyV1 {
  contractVersion: 1;
  policy: {
    mode: "exact" | "tiered";
    rememberedTier: ModelTier | null;
    currentTier: ModelTier | null;
    currentRuntime: ExactModelSelection;
    nextRequestResolved: ExactModelSelection | null;
    blockedReason: string | null;
  };
  ladder: { valid: boolean; revision: string | null; blockedReason: string | null };
  tierCommands: {
    contractVersion: 1;
    absolute: readonly ["/tier-economy", "/tier-fast", "/tier-standard", "/tier-advanced", "/tier-capable", "/tier-frontier"];
    relative: readonly ["/tier-up", "/tier-down"];
    leadingOnly: true;
    exactOutcome: "ignored-exact";
  };
  trackedDispatch: {
    contractVersion: 1;
    dispatchKey: true;
    tierField: true;
    scope: "parent-session";
    canonicalInputs: readonly ["cwd", "rawPrompt"];
    resultPolicyApplication: true;
  };
}
```

### Conditional invariants

Tuples use the `ExactModelSelection` shape `{ model: { provider, id },
thinkingLevel }` and carry model identity and supported thinking only.

| Condition | Requirement |
| --- | --- |
| Exact mode | `currentTier` is `null`; an invalid ladder is permitted; `currentRuntime` and `nextRequestResolved` are both non-null and equal |
| Valid tiered mode | `currentTier` is non-null; ladder is complete and valid; latest resolved tuple is non-null |
| Invalid tiered mode | `nextRequestResolved` may be `null` only when `ladder.blockedReason` is a non-empty actionable reason; this state is capability-blocking |
| Any policy blocked reason | Capability-blocking regardless of mode |

A capability-blocking state yields `CAPABILITY_BLOCKED` before any worktree
mutation, plan mutation, or dispatch.

## `spawn_subsession` success details

```ts
interface SpawnSubsessionDetailsV1 {
  contractVersion: 1;
  sessionId: string;
  dispatch: { key: string; reused: boolean };
  policyApplication: {
    requestedDirective: string;
    outcome: "directive-applied" | "tier-unchanged" | "ignored-exact";
    mode: "exact" | "tiered";
    tier?: ModelTier;
    resolved: ExactModelSelection;
    at: string;
  };
}
```

The child's durable application entry projects an identical `policyApplication`
value, precedes the cleaned task, and is marked outside model context. Fake
transcript fixtures expose event order and model visibility so tests can assert
both.

### `dispatchKey`

`dispatchKey` is at most 240 characters matching `^[A-Za-z0-9._:-]{1,240}$`. The
server treats it as an opaque bounded string and never parses its structure.

Replay requires the same key, same `cwd`, and same raw prompt. Conflicting reuse
of a key with different canonical inputs fails. A stored result is retained
verbatim after later policy or tier-mapping changes.

Fresh-dispatch validation uses the pre-spawn inspection. Replay validation uses
the complete inspection stored in dispatch intent and never compares the replay
against current policy or ladder state.

### Optional `tier` field

When supplied, `tier` must name the same tier as the leading directive in the
prompt. A disagreement, or a `tier` with no leading directive, fails before child
creation. An omitted `tier` preserves directive-only behavior.

`tier` never applies policy on its own. The directive remains the only
application mechanism; `tier` is a machine-checkable declaration of the same
intent.

### Fail-closed conditions

Missing fields, unknown contract versions, unknown outcomes, contradictory
mode/tier combinations, malformed tuples, reordered or model-visible application
events, and a missing child projection all fail closed.

## Identity-input properties

`rawPrompt` serves two purposes with incompatible tolerances. Directive
recognition is whitespace-tolerant by design; identity comparison tolerates
nothing.

**The directive bytes stay in the identity input.** Stripping the directive
before fingerprinting makes two dispatches that differ only in tier
byte-identical. A reused key would then return the earlier child for a request
that asked for a different tier, reporting `reused: true` with the earlier policy
application and no detectable mismatch. That silent tier substitution is strictly
worse than a false conflict, which halts visibly, so identity must cover the
directive.

**Replay must never re-render the prompt.** Dispatch intent stores the rendered
prompt bytes next to the pre-spawn inspection it already stores, and recovery
reissues those stored bytes verbatim. Re-rendering couples identity to renderer
output, so any drift — including interior drift such as an added blank line after
the directive, which trimming cannot absorb — turns a legitimate recovery into
conflicting reuse.

Identity comparison additionally normalizes a leading byte-order mark, CRLF to
LF, and outer whitespace, so transport-level rewriting does not manufacture a
conflict. Normalization applies only to the bytes compared for identity, never to
the bytes delivered to the child, which must keep the directive at byte zero.
Normalization is insurance for transport, not a substitute for storing the
rendered bytes.
