# Learned Skills Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conditional, read-only Learned Skills Activity Rail plugin backed by an extensible provider API, adapt `pi-hermes-memory` as its first provider, and make both learned skills and existing project memory resolve correctly across linked Git worktrees.

**Architecture:** A new server-side learned-skills domain mirrors the memory provider/catalog/route shape while remaining independently available and polled. A hermes-specific adapter reads global and project `SKILL.md` files, sharing only an upstream-specific project-identity helper with the existing memory adapter. The client owns strict API parsing, stale-safe polling state, and host wiring; a bundled Rail-only plugin renders a responsive, resizable, read-only list/detail UI without importing core internals.

**Tech Stack:** TypeScript, Node 22 filesystem APIs, Fastify 5, Lit 3 plugin templates, plain Web Components, Vitest, Chromium CDP, Changesets.

## Global Constraints

- Prefix every shell command with `source yesconda;`.
- Node `>=22.19.0` is the runtime floor; do not use newer-only APIs.
- Add no runtime dependencies.
- The feature is read-only: no learned-skill create, edit, delete, install, update, or enable/disable control.
- Keep Memory and Learned Skills as independently available providers, controllers, polls, and Activity Rail contributions.
- Resolve hermes project scope without spawning Git: follow `.git` directories or linked-worktree `gitdir:` and `commondir` files, preserve the cwd-name migration bridge, and keep this logic inside `src/server/piHermes/`.
- Use application-relative browser paths without a leading slash, encode query values with `URLSearchParams`, and resolve exactly once through `request()`.
- The bundled plugin id is `workspace-learned-skills`; it is Rail-only and hidden only after every learned-skill provider reports `unavailable`.
- Poll every 30 seconds after request settlement, suppress stale results, preserve last good data on refresh failure, and stop polling on confirmed unavailability.
- Desktop list width defaults to 280px, clamps to 190-440px and leaves at least 320px for details; persist it under `pi-webui:workspace-learned-skills:layout:v1`.
- Below 760px use single-column list/detail navigation, hide the divider, and retain but ignore the desktop width preference.
- Do not modify `README.md` or `CHANGELOG.md`; add one patch Changeset and update `docs/plugins.md` plus `docs/plugins.html`.
- These changes affect the web/API/UI process only. Do not modify `src/server/sessiond.ts`, and do not require a session-daemon restart.
- Keep each task TDD-driven, independently committed, typecheck- and Knip-clean; do not run full suites concurrently with other heavy jobs.

## Task 1: Port Hermes Project Identity And Fix Worktree Memory

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/piHermes/projectIdentity.ts`
- Create: `src/server/piHermes/projectIdentity.test.ts`
- Modify: `src/server/memory/piHermesMemoryProvider.ts:1-128`
- Modify: `src/server/memory/piHermesMemoryProvider.test.ts:1-204`

**Interfaces:**

- Consumes: the existing `PiHermesMemoryProvider` constructor and `MemoryProvider` contract; the fixed hermes storage root `<agentDir>/projects-memory/<projectName>`.
- Produces:

```ts
export type PiHermesPathKind = "directory" | "file" | "missing";

export interface PiHermesProjectIdentityAccess {
  pathKind(path: string): Promise<PiHermesPathKind>;
  readFile(path: string): Promise<string>;
}

export interface PiHermesProjectIdentityInput {
  agentDir: string;
  projectPath: string;
  homeDir?: string;
}

export async function resolvePiHermesProjectName(
  input: PiHermesProjectIdentityInput,
  access?: PiHermesProjectIdentityAccess,
): Promise<string | undefined>;

export type PiHermesProjectNameResolver = (projectPath: string) => Promise<string | undefined>;
```

- Preserves: `new PiHermesMemoryProvider(agentDir, fileAccess?)`; add an optional third `PiHermesProjectNameResolver` argument so existing fake file-access tests remain focused and compatible.

- [ ] **Step 1: Write failing project-identity tests**

Create table-driven tests using an in-memory `PiHermesProjectIdentityAccess`. Pin all of these outcomes:

```ts
expect(await resolvePiHermesProjectName({
  agentDir: "/agent",
  projectPath: "/work/main/src",
  homeDir: "/home/user",
}, fakeAccess({ "/work/main/.git": "directory" }))).toBe("main");

expect(await resolvePiHermesProjectName({
  agentDir: "/agent",
  projectPath: "/work/feature",
  homeDir: "/home/user",
}, fakeAccess({
  "/work/feature/.git": { file: "gitdir: /work/main/.git/worktrees/feature\n" },
  "/work/main/.git/worktrees/feature/commondir": { file: "../..\n" },
}))).toBe("main");
```

Also assert: an older `<main>/.git/worktrees/<name>` layout without `commondir` resolves two levels up; a non-Git path falls back to its basename; `/`, the supplied home directory, `.`, and `..` return `undefined`; non-ENOENT access errors reject; and when `projects-memory/main` is absent but `projects-memory/feature` exists, `feature` wins as the migration bridge.

- [ ] **Step 2: Add a failing memory-provider regression for a linked worktree**

Build a real temporary layout with `main/.git/worktrees/feature/commondir`, `feature/.git` pointing at that gitdir, and only `projects-memory/main/MEMORY.md`. Assert:

```ts
await expect(new PiHermesMemoryProvider(agentDir).read({ projectPath: featurePath }))
  .resolves.toMatchObject({
    kind: "data",
    projectEntries: [{ content: "Worktree-shared project memory" }],
  });
```

This test must fail against the current `basename(projectPath)` implementation by returning no project entries.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
source yesconda; npm test -- --run \
  src/server/piHermes/projectIdentity.test.ts \
  src/server/memory/piHermesMemoryProvider.test.ts
```

Expected: FAIL because `projectIdentity.ts` does not exist and the existing provider looks under the worktree basename.

- [ ] **Step 4: Implement the hermes project-identity helper**

Implement an async port of upstream `pi-hermes-memory/src/project.ts`:

1. Resolve `projectPath`; reject root, home, empty/unsafe basenames.
2. Walk parents for `.git` using `pathKind`.
3. Return the containing directory for a `.git` directory.
4. For a `.git` file, parse exactly `^gitdir:\s*(.+)$` in multiline mode, resolve it relative to the worktree root, then read `commondir` relative to that gitdir.
5. If `commondir` is absent, recognize `<shared>/.git/worktrees/<name>` and return `<shared>`; if the pointer is malformed, retain upstream's fallback to the worktree root.
6. Derive repo basename, then apply the migration bridge against `<agentDir>/projects-memory` using `pathKind`.
7. The Node adapter uses `stat` and `readFile`; only `ENOENT`/`ENOTDIR` become `missing`, while permission and I/O failures propagate.

Add a short source comment naming `pi-hermes-memory` project detection and upstream issue #120 so future upstream changes are repaired in this adapter boundary.

- [ ] **Step 5: Inject the resolver into `PiHermesMemoryProvider`**

Keep the current file adapter unchanged. Add the third constructor collaborator:

```ts
constructor(
  private readonly agentDir: string,
  private readonly fileAccess: MemoryFileAccess = nodeFileAccess,
  private readonly resolveProjectName: PiHermesProjectNameResolver = (projectPath) =>
    resolvePiHermesProjectName({ agentDir, projectPath }),
) {}
```

Make `projectScope()` await the resolver, retain `isUnsafeProjectName`, and preserve all existing availability/error semantics.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
source yesconda; npm test -- --run \
  src/server/piHermes/projectIdentity.test.ts \
  src/server/memory/piHermesMemoryProvider.test.ts
source yesconda; npm run typecheck
```

Expected: PASS; the worktree regression reads the repo-named memory directory.

- [ ] **Step 7: Commit**

```bash
source yesconda; git add src/server/piHermes src/server/memory/piHermesMemoryProvider.ts src/server/memory/piHermesMemoryProvider.test.ts
source yesconda; git commit -m "fix(memory): resolve Hermes project identity across worktrees"
```

- [ ] **Step 8: Prove the regression test is falsifiable against the parent implementation**

Use a temporary archive, never mutate the active worktree:

```bash
source yesconda; current=$(git rev-parse HEAD); tmp=$(mktemp -d)
source yesconda; git archive "$current" | tar -x -C "$tmp"
source yesconda; ln -s "$PWD/node_modules" "$tmp/node_modules"
source yesconda; git show "$current^:src/server/memory/piHermesMemoryProvider.ts" > "$tmp/src/server/memory/piHermesMemoryProvider.ts"
source yesconda; cd "$tmp" && npm test -- --run src/server/memory/piHermesMemoryProvider.test.ts -t "linked worktree"
```

Expected: the linked-worktree regression FAILS against the parent provider. Then remove the temporary directory and verify the active worktree is clean at the recorded SHA.

## Task 2: Build The Learned Skills Provider Domain

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:1544-1564`
- Create: `src/server/learnedSkills/skillDocumentParser.ts`
- Create: `src/server/learnedSkills/skillDocumentParser.test.ts`
- Create: `src/server/learnedSkills/learnedSkillProvider.ts`
- Create: `src/server/learnedSkills/learnedSkillCatalog.ts`
- Create: `src/server/learnedSkills/learnedSkillCatalog.test.ts`
- Create: `src/server/learnedSkills/piHermesLearnedSkillProvider.ts`
- Create: `src/server/learnedSkills/piHermesLearnedSkillProvider.test.ts`

**Interfaces:**

- Consumes from Task 1:

```ts
export type PiHermesPathKind = "directory" | "file" | "missing";

export interface PiHermesProjectIdentityAccess {
  pathKind(path: string): Promise<PiHermesPathKind>;
  readFile(path: string): Promise<string>;
}

export type PiHermesProjectNameResolver = (projectPath: string) => Promise<string | undefined>;

export async function resolvePiHermesProjectName(
  input: { agentDir: string; projectPath: string; homeDir?: string },
  access?: PiHermesProjectIdentityAccess,
): Promise<string | undefined>;
```

- Produces:

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

export interface LearnedSkillProviderInput {
  readonly projectPath?: string;
}

export type LearnedSkillProviderResult = LearnedSkillsSnapshotResponse;

export interface LearnedSkillProvider {
  readonly id: string;
  read(input: LearnedSkillProviderInput): Promise<LearnedSkillProviderResult>;
}

export function parseLearnedSkillDocument(input: {
  id: string;
  filePath: string;
  content: string;
}): LearnedSkill | undefined;

export class LearnedSkillCatalog {
  constructor(providers: readonly LearnedSkillProvider[]);
  read(projectPath: string): Promise<LearnedSkillsSnapshotResponse>;
}

export class PiHermesLearnedSkillProvider implements LearnedSkillProvider {
  readonly id: "pi-hermes-memory";
  constructor(agentDir: string, dependencies?: PiHermesLearnedSkillProviderDependencies);
  read(input: LearnedSkillProviderInput): Promise<LearnedSkillProviderResult>;
}
```

- [ ] **Step 1: Write failing parser tests**

Use real hermes-shaped frontmatter and assert required/optional behavior:

```ts
expect(parseLearnedSkillDocument({
  id: "verify-red",
  filePath: "/agent/pi-hermes-memory/skills/verify-red/SKILL.md",
  content: `---\nname: "verify-red"\ndescription: "Prove RED."\nversion: 2\ncreated: "2026-08-01"\nupdated: "2026-08-05"\n---\n## Procedure\nRun it.`,
})).toEqual({
  id: "verify-red",
  name: "verify-red",
  description: "Prove RED.",
  filePath: "/agent/pi-hermes-memory/skills/verify-red/SKILL.md",
  version: 2,
  created: "2026-08-01",
  updated: "2026-08-05",
});
```

Assert `undefined` for malformed frontmatter, missing/blank `name`, missing/blank `description`, and invalid optional metadata types. Assert valid required fields remain usable when optional metadata is absent.

- [ ] **Step 2: Write failing catalog tests**

Pin: no providers and all-unavailable providers return `{ kind: "unavailable" }`; one available provider is sufficient; ids become `<providerId>:<localId>`; first project warning is retained; successful entries from other providers remain; global and project arrays sort independently by `updated` descending, `created` descending, then name, with undated skills last.

- [ ] **Step 3: Write failing hermes-adapter tests**

Use temporary directories and an injected file adapter/resolver. Cover:

- neither global nor selected-project skills root exists -> unavailable;
- a project-only root remains available;
- an existing empty root -> data with zero skills;
- global path `<agentDir>/pi-hermes-memory/skills/<slug>/SKILL.md`;
- project path `<agentDir>/projects-memory/<resolvedProject>/skills/<slug>/SKILL.md`;
- non-directory children and missing `SKILL.md` are ignored;
- unreadable or invalid individual skill files are skipped;
- failed project listing preserves global skills and adds `Project-specific learned skills could not be loaded.`;
- a failed project probe rejects only when no global root is available.

- [ ] **Step 4: Run focused tests and confirm RED**

```bash
source yesconda; npm test -- --run \
  src/server/learnedSkills/skillDocumentParser.test.ts \
  src/server/learnedSkills/learnedSkillCatalog.test.ts \
  src/server/learnedSkills/piHermesLearnedSkillProvider.test.ts
```

Expected: FAIL because the domain does not exist.

- [ ] **Step 5: Add shared response types and parse skill documents**

Use `parseFrontmatter` from `@earendil-works/pi-coding-agent`. Trim required strings. Include optional metadata only when `version` is finite and `created`/`updated` are nonempty strings; return `undefined` when any present optional field has the wrong type, matching the strict adapter contract rather than emitting misleading metadata.

- [ ] **Step 6: Implement the provider and catalog**

Use an injected adapter with these operations:

```ts
export interface PiHermesLearnedSkillFileAccess {
  isDirectory(path: string): Promise<boolean>;
  listDirectories(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface PiHermesLearnedSkillProviderDependencies {
  fileAccess?: PiHermesLearnedSkillFileAccess;
  resolveProjectName?: PiHermesProjectNameResolver;
}
```

The Node `listDirectories` adapter uses `readdir({ withFileTypes: true })` and returns directory names only. Probe global and selected-project roots before deciding availability. Catch per-file reads/parses and skip that file; translate project-root probe/list failures into the scoped warning when global data remains; let global-root/list failures surface. Namespace and sort only in `LearnedSkillCatalog`, after provider aggregation.

- [ ] **Step 7: Run focused tests, typecheck, lint, and Knip**

```bash
source yesconda; npm test -- --run \
  src/server/learnedSkills/skillDocumentParser.test.ts \
  src/server/learnedSkills/learnedSkillCatalog.test.ts \
  src/server/learnedSkills/piHermesLearnedSkillProvider.test.ts
source yesconda; npm run typecheck
source yesconda; npx eslint src/server/learnedSkills src/shared/apiTypes.ts
source yesconda; npm run knip
```

Expected: all pass; test imports keep staged exports Knip-visible.

- [ ] **Step 8: Commit**

```bash
source yesconda; git add src/shared/apiTypes.ts src/server/learnedSkills
source yesconda; git commit -m "feat(skills): add learned skill provider domain"
```

## Task 3: Expose The Federated Snapshot API

**Implementer tier:** Advanced

**Files:**

- Create: `src/server/learnedSkills/learnedSkillsRoutes.ts`
- Create: `src/server/learnedSkills/learnedSkillsRoutes.test.ts`
- Modify: `src/server/app.ts:39-40,235-237`
- Modify: `src/shared/federatedRoutes.ts:14-35`
- Modify: `src/client/src/api/federatedRouteContract.test.ts:75-95`
- Modify: `src/client/src/api/parsers.ts:1-95`
- Modify: `src/client/src/api/parsers.test.ts:1-55`
- Modify: `src/client/src/api/clients.ts:1-170,509-526`
- Modify: `src/client/src/api/clients.test.ts:1-125`
- Modify: `src/client/src/api.ts:1-8`

**Interfaces:**

- Consumes from Task 2:

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

export class LearnedSkillCatalog {
  constructor(providers: readonly LearnedSkillProvider[]);
  read(projectPath: string): Promise<LearnedSkillsSnapshotResponse>;
}

export class PiHermesLearnedSkillProvider implements LearnedSkillProvider {
  constructor(agentDir: string, dependencies?: PiHermesLearnedSkillProviderDependencies);
}
```

- Produces:

```ts
export function registerLearnedSkillsRoutes(
  app: FastifyInstance,
  agentProfileProvider: ActiveAgentProfileProvider,
  prefix: string,
): void;

export function parseLearnedSkillsSnapshotResponse(value: unknown): LearnedSkillsSnapshotResponse;

export const learnedSkillsApi: {
  snapshot(projectPath: string, machineId?: string): Promise<LearnedSkillsSnapshotResponse>;
};
```

- HTTP contract: `GET <prefix>/agent-skills/snapshot?projectPath=<encoded>` with `Cache-Control: no-store`; 400 missing/empty path; 503 unavailable active profile; 200 `unavailable` or `data` snapshot.

- [ ] **Step 1: Write failing route tests**

Build Fastify with both `/api` and `/api/machines/local`. Assert missing and `projectPath=` are 400, unavailable profile is 503, no provider roots returns `{ kind: "unavailable" }`, a real global/project skill fixture returns both arrays and `no-store`, and the local-machine prefix resolves.

- [ ] **Step 2: Write failing strict-parser tests**

Use this valid shape and assert exact output:

```ts
parseLearnedSkillsSnapshotResponse({
  kind: "data",
  globalSkills: [{
    id: "pi-hermes-memory:global",
    name: "global",
    description: "Global skill",
    filePath: "/agent/pi-hermes-memory/skills/global/SKILL.md",
    version: 2,
  }],
  projectSkills: [],
});
```

Reject: missing/unknown `kind`; non-array scopes; missing or non-string required skill fields; non-number `version`; non-string `created`/`updated`; and non-string `projectUnavailableMessage`. Accept `{ kind: "unavailable" }`.

- [ ] **Step 3: Write failing client and federation tests**

Stub `fetch`, call:

```ts
await learnedSkillsApi.snapshot("/repo with spaces/?", "remote /?");
```

Assert the browser boundary resolves the app-relative reference exactly once. The fetch mock must
receive:

```text
https://pi.example.test/nested/pi-webui/api/machines/remote%20%2F%3F/agent-skills/snapshot?projectPath=%2Frepo+with+spaces%2F%3F
```

Assert `FEDERATED_HTTP_ROUTES` contains `{ method: "GET", path: "/agent-skills/snapshot" }`.

- [ ] **Step 4: Run focused tests and confirm RED**

```bash
source yesconda; npm test -- --run \
  src/server/learnedSkills/learnedSkillsRoutes.test.ts \
  src/client/src/api/parsers.test.ts \
  src/client/src/api/clients.test.ts \
  src/client/src/api/federatedRouteContract.test.ts
```

Expected: FAIL for missing route, parser, client, and allowlist entry.

- [ ] **Step 5: Implement and register the route**

Follow the memory snapshot route's boundary mapping exactly. Instantiate `LearnedSkillCatalog([new PiHermesLearnedSkillProvider(profile.dir)])` only after `requireActiveAgentProfile()`. Register under both app prefixes in `buildApp`; do not touch sessiond.

- [ ] **Step 6: Implement strict browser parsing and client path construction**

Add a `parseLearnedSkill` helper that checks optional fields when present instead of silently dropping invalid values. Build the path with `URLSearchParams({ projectPath })` and `${machinePrefix(machineId)}/agent-skills/snapshot?...`; export `learnedSkillsApi` from `api.ts` and include it in the aggregate `api` object.

- [ ] **Step 7: Run focused tests and verification for changed contracts**

```bash
source yesconda; npm test -- --run \
  src/server/learnedSkills/learnedSkillsRoutes.test.ts \
  src/client/src/api/parsers.test.ts \
  src/client/src/api/clients.test.ts \
  src/client/src/api/federatedRouteContract.test.ts
source yesconda; npm run typecheck
source yesconda; npx eslint \
  src/server/learnedSkills/learnedSkillsRoutes.ts \
  src/server/learnedSkills/learnedSkillsRoutes.test.ts \
  src/server/app.ts src/shared/federatedRoutes.ts \
  src/client/src/api.ts src/client/src/api/clients.ts src/client/src/api/parsers.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
source yesconda; git add src/server/learnedSkills src/server/app.ts src/shared/federatedRoutes.ts src/client/src/api src/client/src/api.ts
source yesconda; git commit -m "feat(skills): expose learned skill snapshots"
```

## Task 4: Add Stale-Safe Learned Skills Polling

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/controllers/learnedSkillsController.ts`
- Create: `src/client/src/controllers/learnedSkillsController.test.ts`
- Modify: `src/client/src/appState.ts:1-220`

**Interfaces:**

- Consumes from Task 3:

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

export const learnedSkillsApi: {
  snapshot(projectPath: string, machineId?: string): Promise<LearnedSkillsSnapshotResponse>;
};
```

Also consumes existing `GetState = () => AppState`, `SetState = (patch: Partial<AppState>) => void`, and `selectedMachineId(state)` controller helpers.

- Produces:

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

export interface LearnedSkillsTimer {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

export interface LearnedSkillsControllerDependencies {
  snapshot?: (projectPath: string, machineId: string) => Promise<LearnedSkillsSnapshotResponse>;
  timer?: LearnedSkillsTimer;
  pollIntervalMs?: number;
}

export class LearnedSkillsController {
  constructor(getState: GetState, setState: SetState, deps?: LearnedSkillsControllerDependencies);
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}
```

- Adds `learnedSkills: LearnedSkillsWorkspaceState` to `AppState`, `WorkspaceScopedStateReset`, `resetWorkspaceScopedState()`, and `initialAppState()`, initialized/reset to `{ kind: "loading" }`.

- [ ] **Step 1: Write failing controller tests**

Adapt the proven MemoryController harness with `LearnedSkill` fixtures. Pin:

1. immediate load and a single 30,000ms timer scheduled only after settlement;
2. no overlapping poll and refresh joining a same-scope in-flight request;
3. late workspace-A result discarded after workspace-B becomes current;
4. machine, project id, workspace id, and workspace path each participate in scope identity;
5. `unavailable` stops observation and leaves no timer;
6. disabling observation clears the timer and re-enabling restarts;
7. zero-skill data remains `kind: "data"`;
8. scoped project warning is preserved;
9. background failure retains good data and adds `refreshError`;
10. first failure uses `kind: "error"` and schedules retry;
11. synchronous throws do not leave a settled in-flight request registered;
12. `dispose()` clears timers and drops late results;
13. workspace reset returns learned skills to loading.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
source yesconda; npm test -- --run src/client/src/controllers/learnedSkillsController.test.ts
```

Expected: FAIL because controller and state field do not exist.

- [ ] **Step 3: Implement the polling state machine**

Use an independent controller, not a generic shared poller. Preserve the exact invariants:

```ts
interface LearnedSkillsScope {
  key: string;
  machineId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
}
```

Increment a generation on invalidation; register an `InFlightLearnedSkillsRequest` before invoking a collaborator that may throw synchronously; reuse a current-scope promise; compare generation plus all four scope fields before applying results; schedule only in `finally` for the current request; and stop observation after applying `unavailable`.

Map snapshots without retaining stale `refreshError`. On failure, preserve existing data with `{ ...data, refreshError: String(error) }`; otherwise set `{ kind: "error", message: String(error) }`.

- [ ] **Step 4: Add AppState ownership and reset behavior**

Import `LearnedSkill` from shared API types. Add `learnedSkills` beside `memory` everywhere AppState is initialized or workspace-scoped state is reset. Do not wire PiWebUiApp yet; tests consume the controller directly, keeping this commit independently useful and Knip-visible.

- [ ] **Step 5: Run focused tests, typecheck, lint, and Knip**

```bash
source yesconda; npm test -- --run src/client/src/controllers/learnedSkillsController.test.ts
source yesconda; npm run typecheck
source yesconda; npx eslint \
  src/client/src/controllers/learnedSkillsController.ts \
  src/client/src/controllers/learnedSkillsController.test.ts \
  src/client/src/appState.ts
source yesconda; npm run knip
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
source yesconda; git add src/client/src/controllers/learnedSkillsController.ts src/client/src/controllers/learnedSkillsController.test.ts src/client/src/appState.ts
source yesconda; git commit -m "feat(skills): poll learned skill snapshots"
```

## Task 5: Build The Read-Only Resizable Rail Plugin

**Implementer tier:** Capable

**Files:**

- Create: `pi-webui-plugins/workspace-learned-skills/package.json`
- Create: `pi-webui-plugins/workspace-learned-skills/learnedSkillsData.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelLayout.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelLayout.test.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/pi-webui-plugin.ts`
- Create: `pi-webui-plugins/workspace-learned-skills/pi-webui-plugin.test.ts`

**Interfaces:**

- Consumes: core-owned state equivalent to `LearnedSkillsWorkspaceState` from Task 4 through a narrow private cast of public `ActivityRailContext`; callback `onRefreshLearnedSkills(): void` supplied by Task 6.
- Produces:

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

export const learnedSkillsPanelTagName = "pi-webui-learned-skills-panel";
export const LEARNED_SKILLS_LAYOUT_STORAGE_KEY = "pi-webui:workspace-learned-skills:layout:v1";
export const DEFAULT_LIST_WIDTH = 280;
export const MIN_LIST_WIDTH = 190;
export const MAX_LIST_WIDTH = 440;
export const MIN_DETAIL_WIDTH = 320;
export const DIVIDER_WIDTH = 8;

export function readLearnedSkillsListWidth(storage?: LayoutStorage): number;
export function writeLearnedSkillsListWidth(width: number, storage?: LayoutStorage): void;
export function clampLearnedSkillsListWidth(width: number, containerWidth?: number): number;
export function learnedSkillsBadge(state: LearnedSkillsWorkspaceState): number | undefined;
export function isLearnedSkillsPanelVisible(state: LearnedSkillsWorkspaceState): boolean;
export function defineLearnedSkillsPanelElement(): void;

interface LearnedSkillsPanelProperties {
  context: ActivityRailContext | undefined;
  learnedSkillsState: LearnedSkillsWorkspaceState;
  onRetry: (() => void) | undefined;
}
```

- Plugin contract: id from package manifest `workspace-learned-skills`; one Rail item with local id `workspace.learned-skills`, title `Learned Skills`, order `51`, 24px `currentColor` outlined lightbulb icon, no workspace panel.

- [ ] **Step 1: Write failing pure layout tests**

Pin the versioned storage envelope `{ version: 1, listWidth: 320 }`; default on missing, invalid JSON, wrong version, NaN, or throwing storage; static clamp to 190-440; dynamic maximum `containerWidth - 320 - 8`; no throw on quota/privacy errors; and persisted width normalized to an integer.

- [ ] **Step 2: Write failing plugin contribution tests**

Using Lit tag stubs as `workspace-memory` does, assert exactly one Rail item, no panel, id/title/order/icon, visibility false without workspace scope, loading/error/data visible with workspace scope, unavailable hidden, zero count no badge, populated count totals global plus project, and render assigns state plus retry callback to `<pi-webui-learned-skills-panel>`.

- [ ] **Step 3: Write failing jsdom panel tests**

Start the file with `// @vitest-environment jsdom`. Exercise the public custom-element setters and real shadow DOM. Cover:

- loading, first-load error with Retry, zero-data empty state, retained refresh warning, scoped project-unavailable notice, and populated PROJECT/GLOBAL groups;
- groups omitted only when successfully empty; project warning keeps PROJECT visible;
- initial "Select a skill" detail empty state;
- row click selects by namespaced id and renders escaped scope/path/name/description/metadata;
- desktop separator has role/orientation/value attributes;
- pointer drag clamps both ends, updates CSS width, uses pointer capture, and persists on pointerup;
- ArrowLeft/ArrowRight/Home/End resize and persist; unhandled keys do nothing;
- selected skill disappearing on a new snapshot returns to empty detail;
- narrow detail class plus back icon returns to list;
- disconnect removes window listeners and terminates active pointer state.

- [ ] **Step 4: Run focused tests and confirm RED**

```bash
source yesconda; npm test -- --run \
  pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelLayout.test.ts \
  pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts \
  pi-webui-plugins/workspace-learned-skills/pi-webui-plugin.test.ts
```

Expected: FAIL because plugin files do not exist.

- [ ] **Step 5: Implement local data and layout boundaries**

Mirror shared fields locally; do not import core `AppState`. The storage helper accepts `Pick<Storage, "getItem" | "setItem">`, catches browser/storage errors, and uses static clamping when reading. Dynamic clamping is applied by the element whenever its container width is known; mobile CSS retains but ignores the stored custom property.

- [ ] **Step 6: Implement the custom element**

Use a plain `HTMLElement` with open shadow root, synchronous `innerHTML`, escaped user/file content, and explicit listener attachment after each render. Set `:host` to `display: block; height: 100%; min-height: 0` so the internal grid receives the Activity dialog's constrained height. Implement the `context`, `learnedSkillsState`, and `onRetry` setters named in the Interfaces block. Own:

- `state`, `retry`, `selectedSkillId`, `showMobileDetail`, `listWidth`, and current pointer interaction;
- one window resize listener while connected;
- group order PROJECT then GLOBAL;
- buttons for rows, close remains host-owned, an icon-only back button with tooltip/ARIA label on mobile;
- CSS grid `var(--learned-skills-list-width) 8px minmax(320px, 1fr)` on desktop;
- an 8px separator hit target with a visible 2px line that highlights on hover/focus/drag;
- pointer capture, `touch-action: none`, and persistence only after a completed drag;
- keyboard step 24px, Shift step 72px, Home minimum, End runtime maximum;
- `@media (max-width: 760px)` single-column list/detail replacement with no divider.

The UI is read-only. Do not render toggles, Add, Delete, Edit, Check updates, or explanatory feature copy.

- [ ] **Step 7: Implement the bundled plugin contribution**

Follow `workspace-memory`'s narrow cast pattern. Use `visible` only when `workspaceScope` exists and state is not unavailable. Return count only for nonzero data. Register the element once in `activate()` and render:

```ts
html`<pi-webui-learned-skills-panel
  .context=${context}
  .learnedSkillsState=${learned.state.learnedSkills}
  .onRetry=${learned.onRefreshLearnedSkills}
></pi-webui-learned-skills-panel>`
```

- [ ] **Step 8: Run focused tests and plugin checks**

```bash
source yesconda; npm test -- --run \
  pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelLayout.test.ts \
  pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts \
  pi-webui-plugins/workspace-learned-skills/pi-webui-plugin.test.ts \
  pi-webui-plugins/pluginPublicApi.test.ts
source yesconda; npm run build:plugins
source yesconda; npm run typecheck
source yesconda; npx eslint pi-webui-plugins/workspace-learned-skills
source yesconda; npm run knip
```

Expected: all pass; `dist/pi-webui-plugins/workspace-learned-skills/` is produced by the build but remains ignored.

- [ ] **Step 9: Commit**

```bash
source yesconda; git add pi-webui-plugins/workspace-learned-skills
source yesconda; git commit -m "feat(skills): add learned skills Rail plugin"
```

## Task 6: Wire Learned Skills Into The Host Lifecycle

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:1-330,620-640,1170-1210,2335-2370,2770-2800,2935-2960,3035-3060,4460-4480`
- Create: `src/client/src/components/PiWebUiApp.learnedSkills.test.ts`
- Modify: `src/client/src/components/PiWebUiApp.memory.test.ts:1-520` only where shared scope-polling names change

**Interfaces:**

- Consumes from Task 4:

```ts
export class LearnedSkillsController {
  constructor(getState: GetState, setState: SetState, deps?: LearnedSkillsControllerDependencies);
  updatePolling(observed?: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
}
```

Also consumes the fixed Task 5 contract: source plugin id `workspace-learned-skills`, local contribution id `workspace.learned-skills`, and public `ActivityRailContext` safe visibility evaluation.

- Produces the private host extension:

```ts
interface InternalActivityRailContext extends ActivityRailContext {
  onRefreshMemory: () => void;
  onRefreshLearnedSkills: () => void;
}
```

- Owns `private readonly learnedSkills = new LearnedSkillsController(...)`, disposes it with the app, and supplies `state.learnedSkills` through the existing runtime state object.
- Activity identity constants:

```ts
const LEARNED_SKILLS_ACTIVITY_RAIL_PLUGIN_ID = "workspace-learned-skills";
const LEARNED_SKILLS_ACTIVITY_RAIL_LOCAL_ID = "workspace.learned-skills";
const LEARNED_SKILLS_ACTIVITY_RAIL_ID = "workspace-learned-skills:workspace.learned-skills";
```

- [ ] **Step 1: Write failing host lifecycle tests**

Register a test learned-skills Rail plugin in `PluginRegistry` and assert:

1. selected workspace plus visible activity calls `learnedSkills.updatePolling(true)`;
2. no workspace, absent activity, or `state.learnedSkills.kind === "unavailable"` calls `false` and hides the item;
3. same workspace id with changed path restarts observation;
4. visibility is evaluated without invoking badge;
5. selected remote machine observes its machine-scoped learned-skills activity, not the gateway copy;
6. `createActivityRailContext()` exposes `onRefreshLearnedSkills`, and invoking it calls controller `refresh()`;
7. `disconnectedCallback()` calls controller `dispose()`;
8. external plugin registration re-evaluates learned-skills polling for the active workspace;
9. existing Memory lifecycle tests remain green.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
source yesconda; npm test -- --run \
  src/client/src/components/PiWebUiApp.learnedSkills.test.ts \
  src/client/src/components/PiWebUiApp.memory.test.ts
```

Expected: FAIL because PiWebUiApp does not own or expose the learned-skills controller.

- [ ] **Step 3: Add host ownership and context wiring**

Import/construct/dispose the controller beside Memory. Extend only the internal context, not `plugin-api.d.ts`. Add `onRefreshLearnedSkills` in `createActivityRailContext()`; the bundled plugin reaches it through its narrow private cast, just as Memory does.

- [ ] **Step 4: Add independent visibility-driven polling**

Rename `memoryPollingScopeChanged` to `workspaceScopeChanged` and use it for both controllers. Keep separate synchronizers so either provider can stop without affecting the other:

```ts
private synchronizeLearnedSkillsPollingForSelectedWorkspace(
  activities = this.plugins.getActivityRailItems(),
): void;

private synchronizeLearnedSkillsPolling(
  activities: readonly QualifiedActivityRailContribution[],
): void;
```

The learned synchronizer must use `isActivityRailItemVisible()` and `isLearnedSkillsActivityRailItem()` without evaluating the badge. Invoke both Memory and Learned Skills synchronizers on workspace/scope change, Activity Rail enumeration, and successful external plugin registration. A missing workspace disables both.

- [ ] **Step 5: Run focused lifecycle and activity tests**

```bash
source yesconda; npm test -- --run \
  src/client/src/components/PiWebUiApp.learnedSkills.test.ts \
  src/client/src/components/PiWebUiApp.memory.test.ts \
  src/client/src/components/PiWebUiApp.activityRail.test.ts \
  src/client/src/components/PiWebUiApp.activityRail.focus.test.ts
source yesconda; npm run typecheck
source yesconda; npx eslint \
  src/client/src/components/PiWebUiApp.ts \
  src/client/src/components/PiWebUiApp.learnedSkills.test.ts \
  src/client/src/components/PiWebUiApp.memory.test.ts
source yesconda; npm run knip
```

Expected: all pass; Memory behavior is unchanged and learned skills are independently observed.

- [ ] **Step 6: Commit**

```bash
source yesconda; git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.learnedSkills.test.ts src/client/src/components/PiWebUiApp.memory.test.ts
source yesconda; git commit -m "feat(skills): wire learned skills into the Activity Rail"
```

## Task 7: Document, Probe, And Verify The Complete Feature

**Implementer tier:** Advanced

**Files:**

- Modify: `docs/plugins.md:195-255`
- Modify: `docs/plugins.html:270-325`
- Create: `.changeset/tidy-learned-skills.md`
- Do not retain: temporary Chromium fixture/script/profile/log files used for layout probing

**Interfaces:**

- Consumes: the complete HTTP, controller, plugin, and host behavior from Tasks 1-6.
- Produces: canonical user documentation, a patch Changeset, measured desktop/mobile layout evidence, and clean full-project verification.

- [ ] **Step 1: Add the Changeset before user-facing docs**

Create exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add a read-only Learned Skills Activity Rail view for reviewing global and project skills generated by compatible Pi packages, and resolve Hermes project memory correctly across linked Git worktrees.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 2: Document the built-in plugin in Markdown and HTML**

Add `### Learned Skills` immediately after Memory with these exact claims, expressed naturally in each format:

- plugin id `workspace-learned-skills`;
- Rail-only and read-only; it cannot add, edit, delete, install, update, enable, or disable skills;
- groups project and global learned skills in a resizable list/detail view;
- the Rail control appears while a compatible provider loads, has data, or errors, and hides only after all providers report unavailable;
- badge totals both scopes only when nonzero;
- selected workspace/machine changes refresh immediately, then poll approximately every 30 seconds; no realtime guarantee;
- install/change detection requires a browser reload after polling has stopped on unavailable;
- disable snippet:

```json
{
  "plugins": {
    "workspace-learned-skills": { "enabled": false }
  }
}
```

Also amend Memory's project-scope wording to state that linked worktrees share the repository-root hermes identity. Keep README unchanged.

- [ ] **Step 3: Run documentation and packaging checks**

```bash
source yesconda; git diff --check
source yesconda; npm run build:plugins
source yesconda; npm run pack:dry
```

Expected: the dry-run tarball includes the built `dist/pi-webui-plugins/workspace-learned-skills` plugin and `docs/plugins.md`; no mockup or `.superpowers/` artifacts appear.

- [ ] **Step 4: Run the full verification suite on an otherwise idle machine**

```bash
source yesconda; npm run verify
```

Expected: typecheck, lint, Knip, and all Vitest files pass. Do not run any other full suite concurrently. If a test times out, rerun that file alone before treating it as a code failure.

- [ ] **Step 5: Start isolated feature dev servers**

Use two terminals/process handles from this worktree. If either strict port is occupied, select an
unused adjacent API/UI pair and record the actual URL:

```bash
source yesconda; PI_WEBUI_PORT=8818 npm run dev:web
source yesconda; PI_WEBUI_PORT=8818 npm run dev:client -- --host 127.0.0.1 --port 8819 --strictPort
```

Expected browser URL: `http://127.0.0.1:8819/`. Reuse the long-lived existing session daemon; no sessiond restart is needed.

- [ ] **Step 6: Probe real Chromium desktop geometry**

Following the `probe-narrow-lit-layout-with-chromium-cdp` procedure, use a temporary fixture under
`src/client` that imports the real `PluginActivityDialog`, activates the real bundled plugin,
assigns its qualified activity plus a populated Activity Rail context, and waits for custom-element
rendering plus two animation frames. At viewport 1040x780, measure and require:

- document `scrollWidth <= clientWidth`;
- list starts at 280px by default;
- dragging reaches 190px minimum and runtime maximum `min(440, bodyWidth - 328)`;
- detail pane remains at least 320px at both limits;
- separator is 8px, has no overlap with list rows or detail content, and reports matching ARIA values;
- long skill names ellipsize inside the row rather than widening the grid;
- persisted width survives element reconstruction.

- [ ] **Step 7: Probe narrow geometry and navigation**

At exact widths 760px and 390px via `Emulation.setDeviceMetricsOverride`, require:

- no document or panel horizontal overflow;
- divider hidden and one column visible;
- selecting a row replaces list with details;
- back icon restores list;
- close/title/back controls do not overlap;
- longest skill name and path wrap or ellipsize inside bounds;
- returning to desktop reapplies the persisted width.

Capture screenshots for review outside the repository or under ignored `.superpowers/`; do not stage them.

- [ ] **Step 8: Clean temporary probe artifacts and recheck the tree**

Stop temporary Chromium and its debugging port, remove its profile/log/script and temporary Vite fixture, and confirm:

```bash
source yesconda; git status --short
source yesconda; git diff --check
```

Expected: only `docs/plugins.md`, `docs/plugins.html`, and `.changeset/tidy-learned-skills.md` remain uncommitted in this task. Leave the feature dev servers running for user testing only if their process handles are stable; otherwise report the verified URL/process lifetime honestly.

- [ ] **Step 9: Commit**

```bash
source yesconda; git add docs/plugins.md docs/plugins.html .changeset/tidy-learned-skills.md
source yesconda; git commit -m "docs(skills): document learned skills review"
```

- [ ] **Step 10: Final exact-commit verification**

```bash
source yesconda; npm run verify
source yesconda; npm run build
source yesconda; git diff --check
source yesconda; git status --short
source yesconda; git log --oneline --decorate -8
```

Expected: every command passes, the worktree is clean, the latest commit is the documentation/Changeset commit, and no session-daemon file changed.
