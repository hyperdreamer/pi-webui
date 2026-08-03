# Plus-created root model policy preference

**Date:** 2026-08-03
**Status:** Approved design

## Summary

A root session created through the SESSIONS `+` button should become the only
source of the model policy restored by the next `+` session in the same
workspace on the same machine.

The remembered value is a complete policy: active Exact or Tiered mode, the
remembered Exact model selection, and the remembered tier. These values are
stored user intent. PI WEBUI validates the active branch when it is used but
does not erase, clamp, or replace intent merely because provider or tier
configuration changed.

This design supersedes these assumptions in
`2026-08-03-persisted-starter-model-policy-preference-design.md`:

- the preference owns only mode and tier;
- Pi settings always own the starter Exact branch;
- pre-session composer selections persist immediately;
- an absent preference seeds Exact mode.

The existing design remains authoritative for machine/workspace scope, managed
state ownership, atomic persistence, capability-based federation, and
non-blocking preference diagnostics except where this document changes them.

## Problem

PI WEBUI currently has two model-policy persistence paths:

1. Every root session persists its own complete session model policy in that
   session's JSONL history.
2. The starter preference stores a mode and optional tier per machine and
   workspace, while Pi settings supply the starter Exact model and thinking
   defaults.

The SESSIONS `+` action creates and selects a root immediately. A mode, model,
thinking-level, or tier choice made after that click is therefore an active
session change. The current client deliberately excludes active-session changes
from starter preference persistence. As a result, the next `+` session may open
in Exact mode with no remembered tier even though the user just selected a
complete policy in the previous `+` session.

The old split also makes Exact restoration depend on Pi defaults shared with
other creation paths. It cannot express "the last Exact tuple selected in a
root created by `+`" independently from other sessions or Pi configuration
changes.

## Goals

- Make Tiered / Standard the initial `+` policy for a workspace with no stored
  preference.
- Remember the latest server-confirmed complete policy from a root explicitly
  created through SESSIONS `+`.
- Restore that full policy for the next `+` session on the same machine and in
  the same normalized workspace.
- Preserve both the remembered Exact branch and remembered tier across mode
  switches.
- Preserve unavailable provider, model, thinking-level, and tier intent without
  silent fallback.
- Validate only the active branch when deciding whether a `+` session can be
  created.
- Keep prompt-created roots, imported or legacy roots, `spawn_session` roots,
  and tracked subsessions outside preference writeback.
- Make eligibility durable across reloads, browser tabs, daemon restarts,
  archive/restore, and session reopen.
- Keep session policy application successful when only preference writeback
  fails.
- Preserve compatibility with current clients and older local or remote peers.

## Non-goals

- Making the preference global across workspaces or machines.
- Storing personal last-used state in project configuration or browser storage.
- Changing tier ladder contents, mapping rules, provider configuration, or model
  availability.
- Making an unavailable active policy executable.
- Letting a spawned or prompt-created session become a preference source.
- Deriving defaults by scanning, sorting, or guessing from recent transcripts.
- Changing an existing session's independent model-policy persistence.
- Providing cross-daemon distributed ordering when multiple daemon processes
  incorrectly share one data directory.
- Adding new policy controls or explanatory UI.

## Domain model

### Remembered policy selection

A **remembered policy selection** is durable user intent. It may be temporarily
unavailable under the selected machine's current provider catalog or tier
mapping. Availability is evaluated when the branch is active; unavailability
never erases the stored value.

### Plus-created root session

A **plus-created root session** is a top-level session explicitly created by the
SESSIONS `+` action. It carries durable creation source
`"session-list-plus"`. Being top-level or browser-created is not sufficient:
prompt-created roots and tool-created roots do not qualify.

### Starter model policy preference

The **starter model policy preference** is the complete remembered policy used
to initialize the next `+` root in one normalized workspace on one selected
machine.

```ts
export interface StarterModelPolicyPreference {
  mode: "exact" | "tiered";
  exact: ExactModelSelection;
  /** Remembered while Exact is active; required while Tiered is active. */
  tier?: ModelTier;
}
```

It is intentionally distinct from `SessionModelPolicy` even though the values
have the same shape. A session model policy belongs to one session and controls
runtime dispatch. A starter preference belongs to a machine/workspace scope and
initializes a future plus-created root.

### Invariants

1. A persisted full preference always contains a syntactically complete Exact
   model selection: non-blank provider, model ID, and thinking level.
2. Tiered mode always contains a canonical tier.
3. Exact mode may retain a canonical inactive tier.
4. The active branch alone gates creation or application.
5. An inactive unavailable branch is retained and does not block the active
   branch.
6. Switching to an unavailable branch makes that branch active and blocked
   until configuration is repaired or the user makes a complete valid choice.
7. Only a confirmed policy from a plus-created root may replace the full
   preference.
8. A client draft may be incomplete; an incomplete draft is never persisted as
   a full preference.
9. With no preference, a new-capability client seeds Tiered / Standard.
10. Initial creation and later policy mutation writeback use server-confirmed
    state, never an optimistic client draft.

## Scope and ownership

The selected session daemon defines machine scope. The normalized absolute
workspace path defines workspace scope, matching current
`normalizeRequestCwd()` semantics.

The default managed file remains:

```text
$PI_WEBUI_DATA_DIR/starter-model-policy-preferences.json
```

This is PI WEBUI-managed personal state. It is not browser storage, global user
configuration, project-local committed configuration, or session transcript
content.

Sessiond owns:

- strict preference parsing and migration;
- serialized atomic file replacement;
- creation-source persistence and inspection;
- proof that a source session is eligible;
- reading the newest confirmed session model policy;
- replacing the preference from that confirmed policy.

The client owns:

- rendering the restored draft and unavailable intent;
- active-branch validation against current catalogs;
- requesting full-policy initialization for `+`;
- requesting writeback only after confirmed creation or mutation;
- scoped saving and warning presentation;
- stale machine/workspace/session completion guards.

## Shared contracts

### Complete preference

`StarterModelPolicyPreference` gains required `exact` as shown above. The new
full-policy parser is strict about fields, canonical tier, and non-blank Exact
values. Catalog availability is not a parsing concern.

The session-default routes remain rolling-compatible through explicit response
negotiation. An unversioned read keeps the current version-one response and
always down-projects a full stored policy to `{ mode, tier? }`; an old client
therefore never receives the new nested `exact` field that its strict parser
would reject.

A capable new client requests version two with
`starterModelPolicyContract=2`, encoded through `URLSearchParams`. The selected-
machine proxy forwards that query unchanged. The version-two response combines
Pi defaults with a full or legacy preference:

```ts
export interface LegacyStarterModelPolicyPreference {
  mode: "exact" | "tiered";
  tier?: ModelTier;
}

export type StarterModelPolicyPreferenceResponse =
  | StarterModelPolicyPreference
  | LegacyStarterModelPolicyPreference;

export interface SessionDefaultsV2Response {
  starterModelPolicyContractVersion: 2;
  model?: SessionModel;
  thinkingLevel: string;
  models: SessionModel[];
  thinkingLevels: string[];
  starterModelPolicyPreference?: StarterModelPolicyPreferenceResponse;
  starterModelPolicyPreferenceError?: string;
}
```

The version-two parser requires contract version 2 and distinguishes preference
shapes by the required `exact` field on a full preference. A legacy response is
hydration input and is never accepted as a new full write. The existing
unversioned update route and response retain their version-one contract for old
clients; new full-policy persistence uses confirmed session writeback instead
of widening that update body.

### Creation source

Add the shared source value:

```ts
export type SessionCreationSource = "session-list-plus";
```

`SessionInfo` gains optional `creationSource`. Only
`"session-list-plus"` is exposed by this feature. Existing tracked-subsession
provenance remains an internal daemon concern and does not make a child
eligible.

The browser's `+` start request includes:

```ts
{
  cwd: string;
  creationSource: "session-list-plus";
  initialModelPolicy: StarterModelPolicyPreference;
}
```

The route remains strict. It rejects:

- an unknown source;
- a source without a full initializer;
- a full initializer without a supported contract;
- a request containing both the legacy active-branch `modelPolicy` and the new
  full `initialModelPolicy`;
- malformed or incomplete policy values;
- unknown fields.

Legacy start requests remain accepted unchanged.

### Capability

Add the effective capability:

```text
sessions.modelPolicyStarterSelection
```

Both web and sessiond must advertise it. It covers:

- the full starter preference response and write contract;
- the `session-list-plus` creation source;
- full-policy session initialization;
- session-scoped confirmed-policy writeback.

The existing `sessions.modelPolicyDefaults` capability retains its version-one
mode/tier meaning for compatibility. A new client sends no new fields or
commands to a peer lacking `sessions.modelPolicyStarterSelection`.

### Confirmed-policy writeback

Expose a session-scoped command with no caller-supplied policy:

```ts
rememberCurrentModelPolicy(
  session: SessionLookup,
): Promise<StarterModelPolicyPreference>;
```

The command:

1. Resolves the session under the supplied normalized workspace.
2. Inspects its persisted creation source.
3. Rejects any source other than `session-list-plus`.
4. Inspects the newest valid persisted session model policy.
5. Rejects an absent or malformed policy and refuses to inspect while a policy
   transition is transient. Current catalog unavailability does not invalidate
   syntactically sound persisted intent.
6. Converts the confirmed policy to a distinct starter preference value.
7. Replaces the selected workspace's preference through the existing store.
8. Returns a clone of the committed preference.

Because no policy payload crosses this interface, callers cannot persist an
optimistic draft, an older confirmation, or a policy from another session.

## Creation-source persistence

Sessiond records a versioned custom entry when it creates a root with
`creationSource: "session-list-plus"`. The marker is written as part of root
initialization before the session is announced.

The source parser follows newest-authoritative custom-entry rules and is strict
about version, source, and unknown fields. A malformed newest marker makes the
session ineligible; it never falls back to an older marker. Sessions with no
marker are ordinary roots and remain ineligible.

Session listing, direct creation responses, global `session.created` events,
archive projections, and reopened session projections expose the same optional
`SessionInfo.creationSource`. Cached transient session handling must preserve
it. The source survives session tree navigation and reload but is never inferred
from parentage, an empty transcript, browser cache state, or current selection.

## Preference file version 2

Version 2 stores complete preferences and can preserve untouched version-one
entries during incremental migration.

Conceptual shape:

```json
{
  "version": 2,
  "workspaces": {
    "/workspace/full": {
      "kind": "full",
      "policy": {
        "mode": "exact",
        "exact": {
          "model": { "provider": "acme", "id": "reasoner" },
          "thinkingLevel": "high"
        },
        "tier": "advanced"
      }
    },
    "/workspace/legacy": {
      "kind": "legacy-v1",
      "preference": {
        "mode": "tiered",
        "tier": "frontier"
      }
    }
  }
}
```

The serialized shape above is normative: version-two workspace entries use
exactly `kind` plus `policy` for full values and `kind` plus `preference` for
legacy values. Parsers reject every unknown field.

### Version-one migration

On reading a version-one file, the store parses every workspace with the
existing strict rules and represents each valid entry internally as
`legacy-v1`. It does not rewrite merely because it was read.

When any workspace receives a full write:

- the target workspace becomes a `full` version-two entry;
- every untouched version-one workspace is emitted as an explicit
  `legacy-v1` entry;
- malformed input still blocks replacement rather than being discarded;
- the atomic replacement contains all original workspace keys.

`SessionDefaultsService` hydrates a legacy entry's missing Exact branch from
Pi's raw configured provider, model ID, and thinking-level intent when those
values are complete. Hydration does not require current catalog availability.
An unavailable raw tuple therefore remains visible and blocked in Exact mode.

If legacy Exact intent is incomplete, the client receives an incomplete draft
and Exact remains blocked until the user chooses a complete tuple. A legacy
Tiered record owns no Exact intent. Once its active tier resolves, the client
uses that tier's resolved tuple to complete the otherwise absent inactive Exact
branch for the full initializer. This does not replace remembered intent because
that legacy branch never contained one. Post-creation writeback then upgrades
the workspace to `full`.

New full writes never omit `exact`. New clients do not write `legacy-v1` values.

### Old-client compatibility

A new daemon continues accepting the existing version-one preference update
used by old clients under `sessions.modelPolicyDefaults`. Such a request stores
or replaces a `legacy-v1` entry rather than fabricating a full Exact selection.
A later new client hydrates and upgrades it through the normal flow.

This permits:

- new client with old daemon: current legacy behavior, because the new
  capability is absent and no version-two read is requested;
- old client with new daemon: unversioned reads and writes remain version one;
- new client with new daemon: an explicitly negotiated version-two read and
  full-policy plus-session behavior;
- mixed workspace entries: incremental migration without data loss.

## Modules and interfaces

### StarterModelPolicyPreferenceStore

The existing store remains the deep persistence module. Its interface evolves
to distinguish absent, legacy, full, and invalid inspection results while
keeping one tagged replacement command.

```ts
type StarterPreferenceInspection =
  | { kind: "absent" }
  | { kind: "legacy-v1"; preference: LegacyStarterModelPolicyPreference }
  | { kind: "full"; preference: StarterModelPolicyPreference }
  | { kind: "invalid"; reason: string };

type StarterPreferenceWrite =
  | { kind: "legacy-v1"; preference: LegacyStarterModelPolicyPreference }
  | { kind: "full"; preference: StarterModelPolicyPreference };

interface StarterModelPolicyPreferenceStore {
  inspect(cwd: string): Promise<StarterPreferenceInspection>;
  replace(cwd: string, write: StarterPreferenceWrite): Promise<void>;
}
```

Only the compatibility route constructs a `legacy-v1` write; confirmed-policy
writeback always constructs `full`. The implementation hides file versions,
strict parsing, migration, cloning, operation serialization, temporary-file
cleanup, permissions, and atomic replacement.

### SessionCreationSource domain module

A pure module serializes and inspects the versioned source marker. Callers learn
only the source result, not custom-entry shape or traversal rules.

```ts
type CreationSourceInspection =
  | { kind: "absent" }
  | { kind: "valid"; source: SessionCreationSource }
  | { kind: "invalid"; reason: string };
```

The same module feeds writeback eligibility and `SessionInfo` projection so the
two cannot disagree.

### Session policy initialization

Sessiond gains a full-policy initializer distinct from the legacy active-branch
update. It:

1. Builds the new runtime's resolved Exact tuple.
2. Validates the active branch of the supplied full policy.
3. Applies only the active branch to the runtime.
4. Persists the complete supplied policy, including its inactive branch.
5. Writes the plus-source marker when supplied.
6. Inspects and verifies both records.
7. Announces the session only after successful initialization.

For Tiered, the tier mapping determines the runtime target while the supplied
Exact branch is retained verbatim. For Exact, the Exact branch determines the
runtime target while an optional tier is retained verbatim.

Root-creation cleanup remains atomic from the browser's perspective: a failed
active-branch validation, runtime application, policy append, or source append
aborts and disposes the unseen root.

### RememberCurrentModelPolicy command

A sessiond module coordinates provenance inspection, confirmed-policy
inspection, conversion, and store replacement behind the session-scoped command.
Its persistence dependency is injected so eligibility and failure behavior are
testable without filesystem or network access.

The command is deliberately separate from session policy mutation. Preference
failure cannot roll back an already confirmed runtime/session transition, and a
caller can report it through the established non-blocking preference-warning
path.

### Client starter policy coordinator

The existing draft helpers and preference writer evolve rather than adding a
second state system. They own:

- absent/full/legacy seeding;
- cloning both remembered branches;
- active-branch readiness;
- full initializer construction;
- post-confirmation remember command scheduling;
- machine/workspace/session generation guards;
- saving and error snapshots.

The writer queues remember commands, not policy payloads. Pending calls for one
scope may coalesce because sessiond reads the newest confirmed policy when each
command executes. State remains scoped by machine and normalized workspace.

## Data flow

### Fresh workspace

1. The client reads session defaults and receives no preference.
2. With the new capability, it seeds mode Tiered and tier Standard.
3. It seeds the inactive Exact branch from complete Pi defaults when available.
4. It loads the selected machine's tier catalog.
5. If there is no complete Pi Exact default and Standard resolves, it uses
   Standard's resolved tuple to complete the otherwise absent inactive Exact
   branch. No remembered Exact intent exists in this case, so no stored choice
   is replaced.
6. Standard remains selected while loading or invalid.
7. `+` is blocked until Standard resolves and the deterministic seed has formed
   a full initializer.
8. On `+`, the client sends `session-list-plus` and the full initializer.
9. Sessiond applies Standard's resolved tuple, persists both branches and the
   source marker, then announces the root.
10. The client calls `rememberCurrentModelPolicy` for the resolved session.
11. The store writes the complete version-two preference.

A failed first write leaves the created session valid and selected. The next
starter shows the scoped warning and uses the current in-memory choice for that
page lifetime, but no durable success is claimed.

### Restored Exact preference

1. The complete Exact tuple is displayed verbatim.
2. Its optional inactive tier is retained.
3. Current model and thinking catalogs validate the Exact tuple.
4. If provider/model or thinking support is missing, Exact remains selected and
   `+` is blocked with the specific reason.
5. Configuration refresh or repair revalidates the same tuple without rewriting
   it.
6. A valid `+` start applies Exact and stores the inactive tier unchanged.

### Restored Tiered preference

1. The canonical tier is displayed verbatim.
2. Its inactive Exact tuple is retained.
3. The current ladder validates and resolves the tier.
4. An unavailable mapping keeps the tier selected and blocks `+` with the row's
   reason.
5. Ladder repair revalidates the same tier without rewriting it.
6. A valid `+` start applies the current tier resolution and stores the inactive
   Exact tuple unchanged.

### Confirmed changes inside an eligible root

1. The user edits mode, model, thinking level, or tier.
2. The client may hold an incomplete or invalid draft without persisting it.
3. A complete valid draft is sent through the session model-policy mutation
   path.
4. Sessiond applies, verifies, persists, and returns the confirmed full session
   policy.
5. The client adopts the confirmation.
6. Because `SessionInfo.creationSource` is `session-list-plus`, the client queues
   `rememberCurrentModelPolicy`.
7. Sessiond rereads the newest confirmed policy and replaces the workspace
   preference.

If an older confirmation's remember request runs after a newer policy mutation,
the command reads the newer confirmed policy rather than accepting stale client
state.

### Ineligible sessions

The client never queues writeback for a session without the plus source.
Sessiond independently rejects a direct remember command for such a session.
This includes:

- roots created by sending a prompt from a no-session composer;
- existing or imported sessions with no source marker;
- `spawn_session` roots;
- tracked subsessions;
- sessions whose newest source marker is malformed.

Their own session model policies continue to persist normally.

## Validation semantics

### Active branch only

A restored or initialized policy always retains both branches, but only the
active branch controls readiness:

| Active mode | Required usable value | Inactive value |
| --- | --- | --- |
| Exact | provider/model exists and thinking level is supported | tier retained without gating |
| Tiered | canonical tier resolves through a complete valid ladder | Exact tuple retained without gating |

Switching mode makes the target branch active. If it is unavailable, the draft
is visibly blocked and no server mutation or preference write occurs until it
is repaired or replaced.

### Exact unavailability

- If the provider or model is absent, retain provider and model ID.
- If the model exists but the thinking level is unsupported, retain both model
  and thinking level.
- Show a selected unavailable model in the existing model control rather than
  dropping it because it is absent from selectable options.
- Show the unavailable thinking level and its reason.
- Do not choose another model, the model's first thinking level, `off`, or Pi's
  current default.

An explicit user selection is different from configuration drift. When the user
chooses a different model, the client may clear an incompatible thinking draft
and require an explicit supported level before applying. That edit does not
rewrite the durable preference until the complete tuple is confirmed.

### Tier unavailability

A canonical tier remains stored even if its row cannot resolve. Keep it selected,
show the row-specific reason, and block while Tiered is active. Do not substitute
Standard or a neighboring tier.

### Configuration repair

Catalog reload, provider repair, or ladder repair revalidates the retained value.
When it becomes usable, the block disappears without changing the preference.
No persistence call is needed until a session is successfully created or the
user confirms a different policy in an eligible root.

## Concurrency and ordering

The daemon's existing in-process store queue serializes complete read-modify-
write operations across browser tabs and sessions. The last processed successful
remember command for a machine/workspace is authoritative.

The client does not use timestamps or attempt distributed click ordering. It
uses identity guards so an old completion cannot publish saving state or errors
into another machine, workspace, or selected session.

A remember command always reads the source session's current confirmed policy at
execution time. This turns a delayed command into a read of newer truth rather
than a stale payload write.

Atomic rename protects file integrity. As in the current design, multiple daemon
processes sharing one data directory are unsupported and receive no cross-process
lock in this feature.

## Failure behavior

### Active policy invalid at creation

Do not create or announce a session. Keep the starter open with the remembered
active value selected and show its validation reason. Do not write a preference.

### Session policy mutation failure

Keep the server-confirmed session policy authoritative. Drop or repair the
optimistic draft through existing behavior. Do not issue a remember command.

### Preference read or migration failure

Return valid Pi defaults plus a preference diagnostic. Do not overwrite or
partially migrate the damaged file. The new client uses an in-memory Tiered /
Standard draft; its active tier still must validate. A later remember attempt
may fail against the damaged store and reports the write warning without
changing the created session.

### Preference writeback failure

The root creation or policy mutation remains successful. Show a scoped,
non-blocking warning equivalent to:

```text
Could not remember this model policy; this session still uses it.
```

A later successful remember command for that machine/workspace clears the
warning. An earlier failure completion cannot replace a newer success state.

### Creation-source failure

If source persistence fails during creation, abort the unseen plus-created root.
If the newest persisted marker is malformed on reopen, project no source and
reject writeback with an actionable reason. Never infer eligibility.

### Capability mismatch

Without `sessions.modelPolicyStarterSelection`, the new client sends no source,
full initializer, or remember command. It retains the peer's current legacy
starter behavior. Existing session policy controls continue according to
`sessions.modelPolicy`.

## User interface

No new settings page or model-policy control is added.

The existing composer controls provide all visible behavior:

- Tiered / Standard appears for first use under the new capability.
- Restored mode and branch values appear in existing controls.
- Unavailable Exact values remain visible in their triggers and menus with the
  existing blocked-reason surfaces.
- Unavailable tiers remain visible with their row reason.
- Start/Send is disabled only when the active starter branch is unusable.
- Inactive branch invalidity does not disable creation.
- Preference saving does not disable session work.
- Preference write failure uses the existing scoped warning channel.

The UI must not use helper text to explain persistence or feature behavior.

## Testing strategy

### Pure domain tests

- Parse and clone complete Exact and Tiered preferences.
- Require Exact in every full preference.
- Require tier in Tiered and retain optional tier in Exact.
- Reject unknown fields, blank Exact values, and non-canonical tiers.
- Preserve unavailable values without catalog-aware parsing.
- Validate only the active branch.
- Keep inactive branches through mode round trips.
- Form a full initializer without mutating source values.

### Preference store tests

- Missing files return absent.
- Full version-two preferences round-trip independently by workspace.
- Version-one files inspect as legacy without eager rewrite.
- First full replacement upgrades the file and preserves untouched workspaces as
  explicit legacy entries.
- Old-client legacy replacement remains supported.
- Malformed version-one or version-two input blocks replacement.
- Concurrent replacements are serialized and leave strict valid JSON.
- Failed writes leave the previous file intact and remove temporary files.
- Final and temporary files retain required private permissions.

### Session-default service tests

- Full preferences are returned unchanged alongside Pi defaults.
- Legacy preferences hydrate from raw Pi configured values.
- Unavailable raw legacy Exact intent is retained.
- Incomplete legacy Exact intent remains incomplete and blocked.
- Invalid preference inspection returns defaults plus a diagnostic.
- New full and old legacy update forms reach the correct store method.
- Preference updates never mutate Pi settings.

### Route and browser-contract tests

- Serve a version-one mode/tier projection on an unversioned defaults read.
- Serve and parse the full/legacy union only when
  `starterModelPolicyContract=2` is requested.
- Require `starterModelPolicyContractVersion: 2` in the negotiated response.
- Accept strict full plus-start requests.
- Reject unknown source, source without full policy, mixed legacy/full policy,
  malformed Exact values, missing Tiered tier, and unknown fields.
- Preserve legacy start requests.
- Parse and project optional `SessionInfo.creationSource`.
- Resolve application-relative selected-machine paths exactly once.
- Encode session and workspace path values.
- Require both web and sessiond for the new capability.
- New client with old capability sends no new fields.

### Creation-source tests

- A versioned plus marker round-trips.
- Newest matching marker is authoritative.
- Malformed newest marker does not fall back to older valid intent.
- Missing marker remains absent.
- Plus-created source appears consistently in direct response, created event,
  listing, cached transient projection, archive projection, and reopen.
- Spawned and prompt-created sessions never gain the marker.

### Session initialization tests

- Fresh Tiered / Standard applies tier model then thinking before announcement.
- Full Tiered initialization retains the supplied inactive Exact branch.
- Full Exact initialization retains the supplied inactive tier.
- Invalid active Exact or Tiered branch aborts creation before prompt delivery.
- Invalid inactive branches do not block creation.
- Source append or policy append failure disposes the unseen root.
- Successful creation exposes the plus source and complete policy.

### Confirmed writeback tests

- Eligible plus-created roots remember their newest confirmed full policy.
- Initial successful plus creation can be remembered.
- Confirmed Exact mode/model/thinking and Tiered mode/tier changes can be
  remembered.
- An optimistic, incomplete, failed, or blocked mutation cannot be remembered.
- A delayed command reads the latest confirmed policy rather than an older
  client selection.
- Non-plus roots, `spawn_session`, and tracked subsessions are rejected.
- Preference failure does not roll back session policy or runtime state.

### Client application tests

- Absent preference on a new-capability peer seeds Tiered / Standard and loads
  the tier catalog.
- Old peers retain legacy Exact fallback.
- Full Exact and Tiered preferences restore both branches.
- Exact provider/model and unsupported thinking values remain visible and block
  only in Exact mode.
- Unresolvable tier remains visible and blocks only in Tiered mode.
- Mode switches preserve the inactive branch and expose its block only when it
  becomes active.
- Configuration repair unblocks retained intent without a preference write.
- `+` sends full policy and creation source only when ready.
- Successful `+` queues confirmed writeback; failed creation does not.
- Confirmed active changes queue writeback only for plus-created roots.
- Prompt-created, imported, spawned, and tracked sessions never queue writeback.
- Workspace, machine, session, and request-generation changes ignore stale
  state completions.
- Writeback warnings are non-blocking, scoped, and cleared by later success.

### Verification commands

Run the narrowest affected Vitest files during development. Because the final
change crosses shared contracts, client orchestration, session routes, sessiond
runtime ownership, persistence, and federation, finish with:

```bash
npm run typecheck
npm run lint
npm run verify
```

`npm run verify` is the merge-level gate; the explicit typecheck and lint runs
make failures easier to localize before it.

## Documentation and release

Update:

- `CONTEXT.md` with the revised starter preference and plus-created root terms;
- `docs/config.md` as the canonical detailed behavior;
- `docs/config.html` as its generated/static counterpart;
- the canonical configuration documentation where it currently states that
  Exact remains Pi-owned or active-session changes never affect future defaults.

The historical approved specification remains unchanged; this document records
which of its assumptions are superseded.

Do not expand `README.md`; this remains detailed model-policy behavior.

Add one patch Changeset. Suggested user-facing note:

```text
Restore each workspace's last confirmed model policy from a session created
through SESSIONS +, including Exact model/thinking or Tiered tier selections.
```

The implementation changes sessiond-loaded code, the session start protocol,
creation-source persistence, and the managed preference store. Deployment
requires a manual restart of `pi-webui-sessiond.service`. UI/API autoreload alone
is insufficient.

## Alternatives rejected

### Browser-only eligible session IDs

An in-memory or browser-storage set is smaller, but eligibility disappears or
diverges across reloads, tabs, and devices. It cannot prove session origin to
sessiond.

### Transcript scanning

Choosing the newest plus-created JSONL policy would couple a simple preference
to ordering, archive state, deletion, session discovery, and history parsing.
It also makes "last confirmed choice" ambiguous when multiple sessions remain
active.

### Caller-supplied policy writeback

Sending a policy payload after mutation can race a newer confirmation or persist
an optimistic draft. A policy-free command that reads server truth has a smaller,
safer interface.

### Reusing `sessions.modelPolicyDefaults`

Older peers already advertise that capability but do not understand creation
source, full Exact persistence, or confirmed session writeback. Reusing it would
cause new clients to send unsupported fields. An additive capability preserves
rolling compatibility.

### Clearing unavailable intent

Provider and ladder configuration can be repaired. Clearing a missing model,
unsupported thinking level, or unresolved tier silently destroys the user's
last choice and makes repair invisible. Substitution can also change cost or
capability unexpectedly.

### Persisting pre-session edits immediately

This is the existing behavior, but it cannot enforce "only a successfully
created `+` root is a preference source." Delaying writeback until confirmed
creation provides the required provenance and avoids remembering abandoned or
failed drafts.

## Acceptance criteria

1. A fresh workspace on a fully capable peer seeds Tiered / Standard.
2. A successful first `+` root records its complete confirmed policy.
3. The next `+` root restores the last confirmed mode and both remembered
   branches from an eligible root in the same machine/workspace scope.
4. Exact restores provider, model ID, and thinking level selected in the prior
   eligible root rather than unrelated Pi defaults.
5. Tiered restores the prior eligible root's canonical tier.
6. Switching modes does not erase the inactive Exact selection or tier.
7. Unavailable Exact provider/model or thinking intent remains visible and
   blocks only while Exact is active.
8. An unavailable tier remains visible and blocks only while Tiered is active.
9. Repairing configuration re-enables retained intent without rewriting it.
10. Prompt-created, imported, spawned, and tracked sessions cannot update the
    preference.
11. Plus eligibility survives reload, reopen, archive/restore, and other browser
    tabs.
12. Only successful initialization and server-confirmed policy mutations trigger
    writeback.
13. A delayed writeback command reads the latest confirmed policy.
14. Preference failure never rolls back or changes a session policy.
15. Version-one preferences migrate incrementally without dropping untouched
    workspaces.
16. Old clients continue using version-one writes against a new daemon.
17. New clients retain legacy behavior against peers without the new capability.
18. Focused tests, typecheck, lint, and `npm run verify` pass.
19. User-facing docs and a patch Changeset describe the behavior.
20. Release handoff calls out the required manual session-daemon restart.
