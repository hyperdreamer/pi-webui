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
    tierField: true;
    scope: "parent-session";
    canonicalInputs: readonly ["cwd", "prompt", "tier"];
    returnsSessionId: true;
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

This section describes the **implemented** runtime, verified against
`src/server/sessions/spawnSubsessionTool.ts` and
`src/server/sessions/piSessionService.ts`. Earlier drafts of this file specified
server-side dispatch keying and replay deduplication. The runtime has neither.

```ts
interface SpawnSubsessionParamsV1 {
  prompt: string;
  cwd?: string;
  tier?: ModelTier;
}

interface SpawnSubsessionDetailsV1 {
  sessionId: string;
  cwd: string;
}
```

There is no `dispatchKey` parameter, no `reused` flag, and no returned
`policyApplication`. Parent→child lineage is durable through the parent session's
`pi-webui.subsession.spawned` custom entry, which `listSubsessions` rehydrates
from the persisted session file, so lineage survives a daemon restart. What the
runtime does not provide is *correlation of a repeated call to an earlier child*.

### Tier binding

`tier` is the binding channel. A supplied tier resolves through the machine's
configured ladder to an exact model and thinking level, applied as model-then-
thinking before the child's first request. An unresolvable tier fails the spawn
without creating a child and without substituting a neighbouring tier. An omitted
`tier` inherits the parent's model.

Prompt text never selects a model. The runtime does not scan prompt bytes for
slash directives, so a `/tier-*` line is a human-readable echo with zero control
effect. A test fake that recovers a tier by splitting the prompt is exercising a
channel the runtime does not implement, and cannot detect a child that ignored
the directive.

The one exception is a guard, not a mechanism: a leading `/tier-*` line that
*disagrees* with the typed `tier` is rejected before child creation, so a stale
echoed directive cannot silently imply a tier that was not requested.

### No dispatch idempotency

Repeating a spawn call creates a second child. The contract that consumers may
rely on is therefore **detectable** non-idempotency, not prevented duplication:

- `dispatchKey` is controller-owned. It names a row in the controller's own
  dispatch ledger, is never sent to the tool, and exists so recovery can
  correlate a recorded intent to the `sessionId` the tool returned.
- A crash between the spawn call and the ledger write can orphan a child. This
  window cannot be closed client-side. It must be *visible*: an intent without a
  recorded `sessionId` is ambiguous and requires an explicit ruling.
- Authority for whether work happened is commits and artifacts, never session
  identity. A lost correlation degrades to inspecting `git log` and report files,
  not to an unrecoverable run.

### Fail-closed conditions

Missing required fields, unknown tier values, a tier absent from the configured
ladder, an unavailable model, and a leading directive disagreeing with the typed
tier all fail before a child is created.

## Recovery-input properties

**Recovery must never re-render the prompt.** Dispatch intent stores the rendered
prompt bytes, and a ruling to reissue sends those stored bytes verbatim.
Re-rendering couples recovery to renderer output, so any drift — including
interior drift such as an added blank line, which trimming cannot absorb — changes
what the child receives on a path whose whole purpose is exactness.

Storing the bytes is the entire mitigation. Earlier drafts additionally
fingerprinted `cwd` and prompt bytes for identity comparison and specified
normalization of byte-order marks, CRLF, and outer whitespace. With no
server-side deduplication there is nothing to compare against, so both the
fingerprint and its normalization rules are removed rather than kept as unused
ceremony.
