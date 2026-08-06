# Learned Skills plugin design

Date: 2026-08-06

## Problem

Pi packages such as `pi-hermes-memory` generate skills from a user's daily activity. Those
skills are written to package-owned directories:

- global: `<agentDir>/pi-hermes-memory/skills/<slug>/SKILL.md`
- project: `<agentDir>/projects-memory/<project>/skills/<slug>/SKILL.md`

PI WEBUI cannot currently show them. The existing Skills dialog lists skills through Pi's
`DefaultResourceLoader`, which only scans `<cwd>/.agents/skills/` and `<agentDir>/skills/`.
Verified against this repository: the loader returns 23 skills and none come from the two
directories above, even though they hold 22 skills. `pi-hermes-memory` contributes those roots
through the Pi `resources_discover` extension event, which fires only inside a live Pi session.

Users therefore have no way to review what a skill-generating package has learned about them.

## Goals

- Add a read-only **Learned Skills** Activity Rail activity showing global and project-scoped
  learned skills for the selected workspace.
- Show the Rail control only when a skill-generating package is installed, and hide it otherwise.
- Introduce a provider abstraction so future skill-generating packages need an adapter, not a
  new feature.
- Fix project-scope resolution in the existing memory provider, which has the same defect.

## Non-goals

- Creating, editing, deleting, or enabling/disabling learned skills. The surface is read-only.
- Changing the existing underbar Skills dialog, which manages a different set of skills.
- Realtime updates. Refresh is polled.

### Why read-only

Pi disables a skill through a `disable-model-invocation: true` frontmatter key. Writing that key
to a learned skill is not durable: `pi-hermes-memory`'s `formatFrontmatter` (in
`src/store/skill-utils.ts`) rebuilds frontmatter from exactly `name`, `description`, `version`,
`created`, `updated`, and optional `display_name`, discarding every other key. Learned skills are
precisely the files that package rewrites as it learns, so a toggle written that way would
silently revert. A durable toggle needs a PI WEBUI-owned enablement record and an enforcement
path that does not exist yet. Read-only delivers the review value without shipping a control that
lies about its effect.

## Architecture

Mirrors the existing memory module. Memory and learned skills stay independent: separate
providers, separate availability, separate polling, separate Rail activity. A user may install a
skill-generating package without hermes memory, or the reverse, so independent availability is
what keeps each Rail control's visibility rule honest.

### Server: `src/server/learnedSkills/`

| File | Responsibility |
| --- | --- |
| `learnedSkillProvider.ts` | `LearnedSkillProvider` abstraction: `id` plus `read({ projectPath })`. |
| `learnedSkillCatalog.ts` | Fans out over providers, namespaces ids, aggregates availability. |
| `piHermesLearnedSkillProvider.ts` | Adapter for `pi-hermes-memory` directory layout. |
| `skillDocumentParser.ts` | Parses one `SKILL.md` into structured fields. |
| `piHermesProjectIdentity.ts` | Shared project-name resolution for hermes-backed adapters. |
| `learnedSkillsRoutes.ts` | Registers the snapshot endpoint. |

Provider result shape, matching `MemoryProviderResult`:

```ts
export type LearnedSkillProviderResult =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalSkills: LearnedSkill[];
      projectSkills: LearnedSkill[];
      projectUnavailableMessage?: string;
    };
```

`unavailable` means this provider's whole capability is absent. The catalog reports `unavailable`
only when every provider does; one available provider is enough to show the Rail control. Skill
ids are namespaced `<providerId>:<slug>` so two providers cannot collide.

The hermes adapter determines availability by probing whether its global skills directory exists,
matching how `PiHermesMemoryProvider` probes its own root. A `SKILL.md` that is unreadable or
missing `name`/`description` is skipped rather than failing the whole snapshot.

### Project identity, and the memory fix

`pi-hermes-memory` resolves a project to its **git repository root** basename so every linked
worktree shares one identity (`src/project.ts`, citing upstream issue #120). It does this with
plain filesystem reads and no subprocess: walk up for `.git`; when `.git` is a file, follow its
`gitdir:` pointer to the `commondir` file that points back at the shared git directory. It also
keeps a migration bridge: if `projects-memory/<repoName>` does not exist but
`projects-memory/<cwdName>` does, the older cwd-based name wins so existing data is not orphaned.

PI WEBUI's `PiHermesMemoryProvider` instead uses `basename(projectPath)`, and `MemoryController`
feeds it the selected workspace path. In a linked worktree those disagree: hermes writes to
`projects-memory/pi-webui/`, while PI WEBUI looks in `projects-memory/<worktree-dir>/` and finds
nothing. Given this project's one-worktree-per-writer convention, that is the common case, so
project memory currently reads as empty during most feature work.

`piHermesProjectIdentity.ts` ports that resolution with injected filesystem access, and **both**
`PiHermesLearnedSkillProvider` and `PiHermesMemoryProvider` use it. The existing unsafe-name guard
and `projectUnavailableMessage` behavior in the memory provider are preserved.

The filename is deliberately hermes-flavored. Every consumer is an adapter for the same upstream
package, so the coupling stays contained in the adapter layer; the catalog, route, controller, and
plugin never see it. A future non-hermes provider should resolve project scope however its own
upstream does. The file carries a comment recording where the logic came from and what breaks if
upstream changes it: both features would silently point at empty directories, and the fix is to
update the adapters.

### API contract

`GET /api/agent-skills/snapshot?projectPath=...`, registered at both `/api` and
`/api/machines/local`, with a matching entry in `FEDERATED_HTTP_ROUTES` so remote machines resolve
it. Responses set `Cache-Control: no-store`. Missing or empty `projectPath` is 400;
`ActiveAgentProfileAccessError` is 503. Same envelope as the memory snapshot route.

```ts
export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  version?: number;
  created?: string;
  updated?: string;
}

export type LearnedSkillsSnapshotResponse =
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalSkills: LearnedSkill[];
      projectSkills: LearnedSkill[];
      projectUnavailableMessage?: string;
    };
```

`name` and `description` are required because a `SKILL.md` lacking either is not a usable skill.
`version`, `created`, and `updated` are optional: they are hermes conventions rather than Pi
requirements, so a hand-written skill in those directories may omit them.

`filePath` is absolute. The existing Skills dialog already displays absolute skill paths, and the
path is what makes a skill findable for manual reading or deletion.

Ordering matches hermes's own `loadIndex`: `updated` descending, then `created` descending, then
name. Hermes also tiebreaks on scope, which is moot here because global and project skills are
returned as separate arrays. Sorting happens in the catalog after merging providers, so a
multi-provider result interleaves by recency rather than appearing grouped by provider. Skills
missing `updated`/`created` sort after those that have them. The UI then agrees with what the
agent's own tooling reports, and the most recently learned skills appear first.

Client access follows the URL convention in `AGENTS.md`: a strict
`parseLearnedSkillsSnapshotResponse` in `parsers.ts` that throws on unexpected shapes, and
`learnedSkillsApi.snapshot(projectPath, machineId)` in `clients.ts` routed through `request()`.

### Client state and polling

`LearnedSkillsController` in `src/client/src/controllers/learnedSkillsController.ts`, structurally
identical to `MemoryController`: a scope key over `[machineId, projectId, workspaceId,
workspacePath]`, a generation counter invalidated on scope change, in-flight request dedup,
stale-result suppression on settle, and a poll timer. The concurrency hazards are the ones
`MemoryController` already solves, so it should read as a sibling rather than a variation.

```ts
export type LearnedSkillsWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalSkills: LearnedSkill[];
      projectSkills: LearnedSkill[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };
```

A failed refresh over existing data sets `refreshError` and retains the last good snapshot, so a
transient failure does not blank the panel.

The controller polls on its own timer at memory's 30s cadence. `PiWebUiApp` already has a
`memoryPollingScopeChanged` predicate comparing exactly the four fields both controllers care
about; it is renamed `workspaceScopeChanged` and drives both, rather than duplicating the
comparison.

A skills snapshot costs more I/O than a memory snapshot: memory reads 3 files, while this scans
two directories and reads every `SKILL.md` (22 files in this repository today). That is a few
milliseconds and fine at this size, but it grows with accumulated skills. If it ever matters, the
lever is mtime-based skip-reparse in the provider. Not built now: it adds cache state and tests
for a cost that has not been felt.

Like memory, an `unavailable` snapshot stops polling for that scope entirely. With no
skill-generating package installed, PI WEBUI probes once per scope, gets a negative, and goes
quiet, so users who will never see the control pay no recurring cost. The consequence is that
installing such a package while a tab is open does not reveal the control until the tab reloads or
the workspace changes. Memory behaves identically and `docs/plugins.md` already instructs users to
reload the tab after a package change, so this is documented rather than engineered around.

The controller exposes `refresh()`, wired into the plugin context as `onRefreshLearnedSkills` for
the error-state retry affordance, mirroring `onRefreshMemory`.

### Plugin

New bundled plugin `pi-webui-plugins/workspace-learned-skills/`, laid out like
`workspace-memory`: `package.json` (id `workspace-learned-skills`), `pi-webui-plugin.ts`,
`learnedSkillsPanelElement.ts`, and `learnedSkillsData.ts` declaring the consumed state shape
locally so the plugin stays inside the public plugin API boundary. Bundled plugins are discovered
from `dist/pi-webui-plugins`, so no install step is required.

Rail-only, no workspace panel, matching Memory. `order` sits just after Memory's `50` so the two
read as siblings. Visibility is:

```ts
visible: (context) => context.workspaceScope !== undefined
  && isLearnedSkillsPanelVisible(bundledContext(context).state.learnedSkills)
```

where the helper returns `state.kind !== "unavailable"`. As `workspace-memory` does, the plugin
reads core state through a narrowly-typed cast of `ActivityRailContext` declared in
`learnedSkillsData.ts`, the narrowest boundary available without importing core internals.
`PiWebUiApp` supplies `state.learnedSkills` and `onRefreshLearnedSkills` on the context passed to
Rail contributions, exactly as it supplies `state.memory` and `onRefreshMemory`. The control stays visible while loading
and on error, and is hidden only once a provider confirms the capability is absent. That is the
conditional-icon requirement: no skill-generating package, no icon.

The icon is a 24x24 `currentColor` stroke glyph in the same style as Memory's brain, visually
distinct at Rail size.

Badge is `globalSkills.length + projectSkills.length`, shown only for `kind: "data"` with a
nonzero total, so it is absent while loading, on error, and at zero.

#### Layout

Sidebar list-detail, matching the existing Skills dialog. The left column is a scrollable list
with `PROJECT` and `GLOBAL` group headers each showing a count; an empty group is omitted. The
right pane shows the selected skill: scope badge, file path, name, description, and `version` /
`created` / `updated` when present. Nothing is selected initially, so the detail pane opens on a
"Select a skill" empty state. No toggle, no editing, no delete.

`PluginActivityDialog` sizes the panel `min(1040px, 100%)` by `min(780px, 100%)` and goes
full-screen below 760px, where a two-column split would squeeze both halves. Below that
breakpoint the panel becomes single-column: the list fills the dialog and selecting a skill
replaces it with the detail view plus a back control.

#### States

| State | Rendering |
| --- | --- |
| `loading` | "Loading..." in the list; no badge |
| `data`, zero skills | "No learned skills yet"; no badge |
| `data` with `projectUnavailableMessage` | Scoped notice in the PROJECT group; GLOBAL stays usable |
| `data` with `refreshError` | Inline banner above the still-usable list |
| `error` | Message plus retry button wired to `onRefreshLearnedSkills` |
| `unavailable` | Rail control hidden entirely |

Each mirrors an existing memory state.

## Testing

Per `.agents/skills/testing-guide/SKILL.md`, using the smallest layer that proves each behavior.

**Pure helpers.** `piHermesProjectIdentity.test.ts` is the highest-value file, since it is ported
logic with subtle rules: repo root from a plain `.git` directory; repo root from a linked
worktree's `gitdir:` to `commondir` chain; the older worktree layout without `commondir`; fallback
to path basename outside git; the migration bridge where an existing `projects-memory/<cwdName>`
beats a newly derived repo name; and unsafe names (`.`, `..`, path separators). Injected
filesystem, no real git. `skillDocumentParser.test.ts` covers frontmatter extraction, quoted
values, a missing `name` or `description` causing the file to be skipped, absent optional
metadata, and malformed frontmatter.

**Provider and catalog.** `piHermesLearnedSkillProvider.test.ts`: unavailable when the global root
is absent; data with global skills only; project root resolved through repo identity; an
unreadable `SKILL.md` skipped rather than failing the snapshot; `projectUnavailableMessage` on a
project-scope failure while global stays populated. `learnedSkillCatalog.test.ts`: id namespacing,
unavailable only when all providers are, one available provider sufficing, and sort order.

**Memory regression.** The `PiHermesMemoryProvider` change needs coverage proving project memory
resolves through repo identity, with a worktree path finding the repo-named directory. This
changes shipped behavior, so the existing `piHermesMemoryProvider.test.ts` is extended rather than
merely kept green. Following the `read-only-regression-mutant-probe` skill, the new test is
verified to fail against the old `basename` implementation so it pins the fix instead of passing
vacuously.

**Route contract.** `learnedSkillsRoutes.test.ts`: 400 on missing or empty `projectPath`, 503 on
profile access error, the `no-store` header, and `unavailable`/`data` passthrough. Plus an
assertion that the route is present in `FEDERATED_HTTP_ROUTES`.

**Controller.** `learnedSkillsController.test.ts` with fake timers and an injected snapshot: scope
change discards in-flight results; no duplicate concurrent requests for one scope; poll scheduled
after settle; `unavailable` stops polling; refresh error preserves prior data through
`refreshError`; dispose clears timers.

**Parser and plugin.** `parsers.test.ts` additions for the strict snapshot parser including
rejection cases. Pure-function tests for `learnedSkillsBadge` and `isLearnedSkillsPanelVisible`,
and DOM tests on the panel element for the state matrix and list/detail selection. The panel is a
plain custom element with a shadow root, as the memory panel is, so real DOM interaction is
practical and no TemplateResult handler extraction is needed.

**Narrow-viewport layout.** jsdom cannot compute the 760px collapse, so it is verified with the
Chromium CDP procedure in the `probe-narrow-lit-layout-with-chromium-cdp` skill rather than
asserted in a unit test.

**Verification.** `npm run verify` before handoff, since this touches shared types, the federated
route table, and existing memory behavior.

## Documentation

`docs/plugins.md` gains a `### Learned Skills` entry under Built-in plugins, parallel to
`### Memory`: plugin id, Rail-only nature, the read-only guarantee, the two scopes, the
conditional-visibility rule, badge semantics, the 30s poll with no realtime promise, the
reload-after-install note, and the disable config snippet. `docs/plugins.html` keeps its
user-visible claims in sync.

Per `.agents/skills/documentation-guide/SKILL.md` the README is untouched: this does not change
the product story or the shortest path to a first successful run.

A Changeset is required because the change is user-visible. It covers both the new plugin and the
memory project-resolution fix, which is independently user-visible: project memory begins
appearing in linked worktrees where it previously read as empty.
