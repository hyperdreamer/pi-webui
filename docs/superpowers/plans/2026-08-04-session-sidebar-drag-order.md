# Persistent Session Sidebar Drag Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mouse and touch users drag the active persisted session within its
valid sidebar sibling/pin group and retain that order on the selected machine.

**Architecture:** Extend the existing session metadata store with a signed,
normalized sibling position and expose that position through the additive session
catalog contract. Keep ordering and drag calculations pure, let `SessionList`
own only pointer effects, let `SessionController` own optimistic browser state,
and let `PiSessionService` validate and atomically persist complete groups.

**Tech Stack:** TypeScript 6, Lit 3, Fastify 5, Vitest 4, Node.js filesystem
APIs, Pointer Events, PI WEBUI's split web/session-daemon runtime.

**Approved design:**
`docs/superpowers/specs/2026-08-04-session-sidebar-drag-order-design.md`

**File map:**

- `src/shared/apiTypes.ts` owns additive capability, request/response, scope,
  limits, and `SessionInfo.manualOrder` types.
- `src/client/src/sessionTreeRows.ts` owns pure pin/workspace/manual ordering.
- `src/server/sessions/sessionMetadataStore.ts` owns strict durable order
  parsing and atomic normalized group writes.
- `src/server/sessions/sessionReorder.ts` owns pure server-side group validation
  and typed route failures.
- `src/server/sessions/piSessionService.ts` orchestrates catalog validation,
  metadata writes, and related pin/detach mutations.
- `src/server/sessions/sessionRoutes.ts` owns the strict HTTP parser and status
  mapping.
- `src/shared/federatedRoutes.ts` allowlists the same mutation for selected
  remote-machine proxying.
- `src/client/src/api/` owns the application-relative browser contract.
- `src/client/src/controllers/sessionController.ts` owns optimistic mutation,
  stale completion guards, rollback, and refresh recovery.
- `src/client/src/sessionReorder.ts` owns pure sidebar eligibility, insertion,
  move, threshold, and edge-scroll calculations.
- `src/client/src/components/SessionList.ts` owns grip rendering and temporary
  pointer state.
- `AppNavigationPanel.ts` and `PiWebUiApp.ts` only forward capability and
  callbacks across the existing app-shell boundary.

## Global Constraints

- Node.js `>=22.19.0` is the version floor; do not use newer runtime APIs.
- Add no runtime or development dependency; use Lit, Pointer Events, Vitest,
  Fastify, existing helpers, and Node.js APIs already in the repository.
- Preserve hierarchy: roots reorder only with roots in the same canonical CWD;
  children reorder only under the exact same `parentSessionPath`; a drag never
  reparents or detaches.
- Preserve global pin-first behavior and never mix pinned/unpinned groups.
- Sessions without `manualOrder` sort before positioned peers, preserving source
  order, so new sessions remain visible at the top.
- Only the active, persisted, current local row may expose a grip; search,
  Archived, bulk selection, rename, transient rows, external rows, and the
  expanded Sessions browser stay non-draggable.
- The first version supports mouse and touch pointer dragging, not keyboard
  reordering.
- Use a 6 CSS-pixel Euclidean drag threshold, a 32 CSS-pixel edge-scroll zone,
  a 12 CSS-pixel-per-frame maximum, a reserved 24px grip slot, and the exact
  tooltip `Drag to reorder selected session`.
- Reorder requests contain at most 1,000 catalog CWDs and 1,000 ordered session
  refs; parse every object strictly and normalize every CWD at the route edge.
- Build PI WEBUI-owned browser paths without a leading slash; encode dynamic URL
  segments exactly once and send ordinary JSON through `request()`.
- Persist only in `$PI_WEBUI_DATA_DIR/session-metadata.json`; do not add config
  keys, browser storage, or a second order file.
- Capability `sessions.reorder` requires both web and session-daemon support;
  an old/mixed runtime must retain existing order and render no grip.
- Keep each intermediate commit typecheck-, lint-, test-, and Knip-clean; do not
  stage unused future exports.
- Follow TDD: run each focused red test before implementation and the same test
  green afterward.
- Add one patch Changeset for the user-visible feature; never edit
  `CHANGELOG.md` manually.
- Changes affecting the daemon require a manual restart of
  `pi-webui-sessiond.service` before end-to-end use.
- Every task's requirements implicitly include this section.

## Task 1: Add additive manual-order parsing and pure tree projection

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:571-588`
- Modify: `src/client/src/api/parsers.ts:193-215,618-621`
- Modify: `src/client/src/api/parsers.test.ts:462-485`
- Modify: `src/client/src/sessionTreeRows.ts:46-137`
- Create: `src/client/src/sessionTreeRows.order.test.ts`

**Interfaces:**

- Consumes: existing `SessionInfo`, `SessionRow`, and `sessionRows()` contracts.
- Produces: `SessionInfo.manualOrder?: number`, parsed only as a non-negative safe
  integer.
- Produces: `sessionRows(sessions, options): SessionRow[]` with global pin-first
  behavior, workspace-local root positions, exact-parent child positions,
  unordered-first fallback, and stable ties.

- [ ] **Step 1: Write the failing parser and projection tests**

Extend the existing `parseSessionInfo` test with the field and invalid values:

```ts
expect(parseSessionInfo({
  id: "s1",
  path: "/sessions/s1.jsonl",
  cwd: "/repo",
  persisted: true,
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:01:00.000Z",
  messageCount: 0,
  firstMessage: "",
  manualOrder: 3,
})).toMatchObject({ id: "s1", manualOrder: 3 });

for (const manualOrder of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  expect(() => parseSessionInfo({
    id: "s1",
    path: "/sessions/s1.jsonl",
    cwd: "/repo",
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: "",
    manualOrder,
  })).toThrow("Expected non-negative safe integer field: manualOrder");
}
```

Create `sessionTreeRows.order.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { sessionRows } from "./sessionTreeRows";

function session(id: string, cwd: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    persisted: true,
    created: "2026-08-04T00:00:00.000Z",
    modified: "2026-08-04T00:00:00.000Z",
    messageCount: 0,
    firstMessage: id,
    ...patch,
  };
}

function ids(sessions: SessionInfo[]): string[] {
  return sessionRows(sessions).map((row) => row.session.id);
}

describe("manual session tree order", () => {
  it("keeps all pinned roots first and applies positions only inside each root workspace", () => {
    expect(ids([
      session("a-two", "/a", { manualOrder: 2 }),
      session("b-one", "/b", { manualOrder: 1 }),
      session("a-new", "/a"),
      session("b-zero", "/b", { manualOrder: 0 }),
      session("a-zero", "/a", { manualOrder: 0 }),
      session("pinned", "/b", { pinned: true, manualOrder: 99 }),
    ])).toEqual(["pinned", "a-new", "a-zero", "a-two", "b-zero", "b-one"]);
  });

  it("orders children only under their exact parent and keeps pinned children first", () => {
    const parentA = session("parent-a", "/a");
    const parentB = session("parent-b", "/a");
    expect(ids([
      parentA,
      session("a-two", "/a", { parentSessionPath: parentA.path, manualOrder: 2 }),
      session("a-new", "/b", { parentSessionPath: parentA.path }),
      session("a-zero", "/a", { parentSessionPath: parentA.path, manualOrder: 0 }),
      session("a-pinned", "/a", { parentSessionPath: parentA.path, pinned: true, manualOrder: 7 }),
      parentB,
      session("b-child", "/a", { parentSessionPath: parentB.path, manualOrder: 0 }),
    ])).toEqual([
      "parent-a", "a-pinned", "a-new", "a-zero", "a-two",
      "parent-b", "b-child",
    ]);
  });

  it("moves a root family as one depth-first unit and preserves duplicate-position source order", () => {
    const later = session("later", "/a", { manualOrder: 1 });
    const first = session("first", "/a", { manualOrder: 0 });
    expect(ids([
      later,
      session("later-child", "/a", { parentSessionPath: later.path }),
      first,
      session("first-child", "/a", { parentSessionPath: first.path }),
      session("tie-a", "/a", { manualOrder: 2 }),
      session("tie-b", "/a", { manualOrder: 2 }),
    ])).toEqual(["first", "first-child", "later", "later-child", "tie-a", "tie-b"]);
  });

  it("does not compare an orphaned child's child-scope position with true roots", () => {
    const orphan = session("orphan", "/a", {
      parentSessionPath: "/sessions/missing-parent.jsonl",
      manualOrder: 0,
    });
    const root = session("root", "/a");
    const rows = sessionRows([orphan, root]);
    expect(rows.map((row) => row.session.id)).toEqual(["orphan", "root"]);
    expect(rows[0]).toMatchObject({ depth: 0, hasMissingParent: true });
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm red failures**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/sessionTreeRows.order.test.ts
```

Expected: FAIL because `SessionInfo.manualOrder` is absent, `parseSessionInfo`
drops the field, and `sessionRows()` still preserves only pin/source order.

- [ ] **Step 3: Add the strict additive API field**

Add to `SessionInfo` immediately after `pinned`:

```ts
/** Normalized durable position inside this session's sibling and pin group. */
manualOrder?: number;
```

Parse it without accepting arbitrary numbers:

```ts
const manualOrder = record["manualOrder"] === undefined
  ? undefined
  : requireNonNegativeSafeInteger(record, "manualOrder");

return {
  // existing fields stay unchanged
  ...(pinned === undefined ? {} : { pinned }),
  ...(manualOrder === undefined ? {} : { manualOrder }),
};
```

Reuse the existing `requireNonNegativeSafeInteger()` parser helper; do not add a
second numeric validator.

- [ ] **Step 4: Replace in-place pin sorting with stable scoped ordering**

In `sessionTreeRows.ts`, keep tree discovery unchanged and add these focused
helpers:

```ts
function orderedSessionCohort(
  sessions: readonly SessionInfo[],
  manualOrderFor: (session: SessionInfo) => number | undefined = (session) => session.manualOrder,
): SessionInfo[] {
  return sessions
    .map((session, sourceIndex) => ({ session, sourceIndex }))
    .sort((a, b) => {
      const aOrder = manualOrderFor(a.session);
      const bOrder = manualOrderFor(b.session);
      if (aOrder === undefined && bOrder !== undefined) return -1;
      if (aOrder !== undefined && bOrder === undefined) return 1;
      if (aOrder !== undefined && bOrder !== undefined && aOrder !== bOrder) return aOrder - bOrder;
      return a.sourceIndex - b.sourceIndex;
    })
    .map(({ session }) => session);
}

function orderedSiblingGroup(sessions: readonly SessionInfo[]): SessionInfo[] {
  return [
    ...orderedSessionCohort(sessions.filter((session) => session.pinned === true)),
    ...orderedSessionCohort(sessions.filter((session) => session.pinned !== true)),
  ];
}

function orderedRootSessions(roots: readonly SessionInfo[]): SessionInfo[] {
  const orderPinCohort = (cohort: readonly SessionInfo[]): SessionInfo[] => {
    const rootsByCwd = new Map<string, SessionInfo[]>();
    for (const root of cohort) {
      const workspaceRoots = rootsByCwd.get(root.cwd) ?? [];
      workspaceRoots.push(root);
      rootsByCwd.set(root.cwd, workspaceRoots);
    }
    return [...rootsByCwd.values()].flatMap((workspaceRoots) => (
      orderedSessionCohort(
        workspaceRoots,
        (root) => root.parentSessionPath === undefined ? root.manualOrder : undefined,
      )
    ));
  };
  return [
    ...orderPinCohort(roots.filter((session) => session.pinned === true)),
    ...orderPinCohort(roots.filter((session) => session.pinned !== true)),
  ];
}
```

Visit `orderedRootSessions(roots)` and recurse through
`orderedSiblingGroup(children)`. Remove `compareSessionPinnedFirst` and do not
mutate source arrays with `.sort()`. The root order selector intentionally
returns `undefined` for a promoted missing-parent child, so child-scope metadata
cannot compare it with true roots; its position becomes effective again when
the parent is projected and it returns to a child array.

- [ ] **Step 5: Run focused and static verification**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/sessionTreeRows.order.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionList.crossWorkspace.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/sessionTreeRows.ts src/client/src/sessionTreeRows.order.test.ts
npm run knip
```

Expected: all commands PASS. Existing pin/tree/search tests remain green, and
Knip reports no new unused export.

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/sessionTreeRows.ts src/client/src/sessionTreeRows.order.test.ts
git commit -m "feat(sessions): project durable manual order"
```

## Task 2: Extend session metadata and enrich session catalogs safely

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:438-446`
- Modify: `src/server/sessions/sessionMetadataStore.ts:1-111`
- Modify: `src/server/sessions/sessionMetadataStore.test.ts:1-76`
- Modify: `src/server/sessions/piSessionService.ts:23-90,1514-1575,3455-3484,5980-5986`
- Create: `src/server/sessions/piSessionService.orderMetadata.test.ts`
- Modify: `src/server/sessions/piSessionService.unread.test.ts:380-430`

**Interfaces:**

- Consumes: `SessionInfo.manualOrder?: number` and existing per-path pin metadata
  from Task 1.
- Produces: `SessionReorderScope = { kind: "root"; cwd: string } |
  { kind: "children"; parentSessionPath: string }` in shared API types.
- Produces: `SessionOrderMetadata = { position: number; scope:
  SessionReorderScope; pinned: boolean }` and
  `SessionMetadata = { pinned?: boolean; order?: SessionOrderMetadata }`.
- Produces: injectable `SessionMetadataFileSystem` operations with the current
  Node.js filesystem implementation as the default, so atomic rename failure
  and temporary-file cleanup remain directly testable.
- Produces: `SessionMetadataStore.snapshot(): Promise<Record<string,
  SessionMetadata>>` and `clearOrder(sessionPath: string): Promise<void>`.
- Produces: private `PiSessionService.listFromSnapshots(cwd, sessions,
  archivedRecords, metadata)` so one ordinary list and a later multi-CWD reorder
  catalog can share coherent archive/metadata snapshots without duplicating
  enrichment side effects.
- Preserves: `pin()` and `unpin()` now clear order atomically, `detachParent()`
  clears order after changing lineage, and `list()` emits `manualOrder` only for
  matching scope/pin signatures.

- [ ] **Step 1: Write failing metadata schema and catalog-enrichment tests**

Expand `sessionMetadataStore.test.ts` imports to include `readFile` and
`writeFile`, then add:

```ts
it("parses additive signed order metadata while preserving pin-only files", async () => {
  await writeFile(filePath, JSON.stringify({
    "/old.jsonl": { pinned: true },
    "/ordered.jsonl": {
      pinned: false,
      order: { position: 2, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
  }), "utf8");

  await expect(store.snapshot()).resolves.toEqual({
    "/old.jsonl": { pinned: true },
    "/ordered.jsonl": {
      pinned: false,
      order: { position: 2, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
  });
});

it("rejects malformed order position, scope, and pin signatures", async () => {
  const invalidOrders = [
    [],
    { position: -1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    { position: 0.5, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    { position: Number.MAX_SAFE_INTEGER + 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    { position: 0, scope: { kind: "root" }, pinned: false },
    { position: 0, scope: { kind: "root", cwd: "" }, pinned: false },
    { position: 0, scope: { kind: "root", cwd: "/repo", extra: true }, pinned: false },
    { position: 0, scope: { kind: "children", parentSessionPath: "" }, pinned: false },
    { position: 0, scope: { kind: "future", cwd: "/repo" }, pinned: false },
    { position: 0, scope: { kind: "root", cwd: "/repo" } },
    { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: "no" },
    { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false, extra: true },
  ];
  for (const order of invalidOrders) {
    await writeFile(filePath, JSON.stringify({ "/ordered.jsonl": { order } }), "utf8");
    await expect(store.snapshot()).rejects.toThrow("Invalid session metadata order");
  }
});

it("clears order when pinning, unpinning, or clearing directly", async () => {
  await writeFile(filePath, JSON.stringify({
    "/session.jsonl": {
      order: { position: 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
  }), "utf8");

  await store.pin("/session.jsonl");
  expect(await store.get("/session.jsonl")).toEqual({ pinned: true });
  await writeFile(filePath, JSON.stringify({
    "/session.jsonl": {
      pinned: true,
      order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: true },
    },
  }), "utf8");
  await store.unpin("/session.jsonl");
  expect(await store.get("/session.jsonl")).toEqual({ pinned: false });
  await writeFile(filePath, JSON.stringify({
    "/session.jsonl": {
      pinned: false,
      order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
  }), "utf8");
  await store.clearOrder("/session.jsonl");
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
    "/session.jsonl": { pinned: false },
  });
});
```

Create `piSessionService.orderMetadata.test.ts` with a temporary metadata file,
`sessionRecord()` gateway entries, `emptyArchiveStore()`, and these assertions:

```ts
it("lists only scope-and-pin-matching manual positions", async () => {
  await writeFile(metadataPath, JSON.stringify({
    "/sessions/root.jsonl": {
      order: { position: 3, scope: { kind: "root", cwd: "/workspace" }, pinned: false },
    },
    "/sessions/wrong-cwd.jsonl": {
      order: { position: 4, scope: { kind: "root", cwd: "/other" }, pinned: false },
    },
    "/sessions/wrong-pin.jsonl": {
      pinned: true,
      order: { position: 5, scope: { kind: "root", cwd: "/workspace" }, pinned: false },
    },
    "/sessions/child.jsonl": {
      order: { position: 1, scope: { kind: "children", parentSessionPath: "/sessions/parent.jsonl" }, pinned: false },
    },
    "/sessions/wrong-parent.jsonl": {
      order: { position: 2, scope: { kind: "children", parentSessionPath: "/sessions/other.jsonl" }, pinned: false },
    },
  }), "utf8");

  const listed = await service.list("/workspace");
  expect(listed.find((session) => session.id === "root")).toMatchObject({ manualOrder: 3 });
  expect(listed.find((session) => session.id === "wrong-cwd")?.manualOrder).toBeUndefined();
  expect(listed.find((session) => session.id === "wrong-pin")).toMatchObject({ pinned: true });
  expect(listed.find((session) => session.id === "wrong-pin")?.manualOrder).toBeUndefined();
  expect(listed.find((session) => session.id === "child")).toMatchObject({ manualOrder: 1 });
  expect(listed.find((session) => session.id === "wrong-parent")?.manualOrder).toBeUndefined();
});
```

Give both child gateway records the current parent
`/sessions/parent.jsonl`; the second stored signature deliberately names the
other parent and therefore must not enrich.

In the existing unread detach test, inject a temporary `SessionMetadataStore`
seeded with a child order and assert `metadataStore.get(childFile)` has no order
after `detachParent()` while retaining its pin flag.

The fixture gateway must return paths matching the JSON keys exactly and close
the service/remove its temporary directory in `afterEach`.

- [ ] **Step 2: Run focused tests and confirm red failures**

Run:

```bash
npm test -- --run src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.unread.test.ts
```

Expected: FAIL because order metadata, `snapshot()`, `clearOrder()`, and catalog
enrichment do not exist.

- [ ] **Step 3: Implement strict structured metadata and order-clearing mutations**

Add the shared scope type beside `SessionRef`:

```ts
export type SessionReorderScope =
  | { kind: "root"; cwd: string }
  | { kind: "children"; parentSessionPath: string };
```

In `sessionMetadataStore.ts`, import that type and define:

```ts
export interface SessionOrderMetadata {
  position: number;
  scope: SessionReorderScope;
  pinned: boolean;
}

export interface SessionMetadata {
  pinned?: boolean;
  order?: SessionOrderMetadata;
}

export interface SessionMetadataFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

Add a default object containing the imported Node.js functions and accept it as
the constructor's second dependency. Route every filesystem call in `read()`
and `write()` through that dependency. Keep the default constructor behavior and
file format unchanged.

Expose `snapshot()` as the single full-file read and make entry mutations remove
order without assigning `undefined` under exact optional property types:

```ts
async snapshot(): Promise<Record<string, SessionMetadata>> {
  return await this.read();
}

async pin(sessionPath: string): Promise<void> {
  await this.update(sessionPath, (existing) => ({ ...withoutOrder(existing), pinned: true }));
}

async unpin(sessionPath: string): Promise<void> {
  await this.update(sessionPath, (existing) => ({ ...withoutOrder(existing), pinned: false }));
}

async clearOrder(sessionPath: string): Promise<void> {
  await this.update(sessionPath, withoutOrder);
}

private async update(
  sessionPath: string,
  mutate: (existing: SessionMetadata) => SessionMetadata,
): Promise<void> {
  await this.exclusive(async () => {
    const data = await this.read();
    data[sessionPath] = mutate(data[sessionPath] ?? {});
    await this.write(data);
  });
}

function withoutOrder(metadata: SessionMetadata): SessionMetadata {
  const { order: _order, ...rest } = metadata;
  void _order;
  return rest;
}
```

Retain `pinnedPaths()` as a compatibility query and implement it from the same
strict read path; its existing tests continue to pass even though
`PiSessionService.list()` moves to `snapshot()`.

Parse `order`, `scope`, `position`, and `pinned` strictly. Reject arrays, empty
scope strings, unsupported scope kinds, non-safe positions, and unsupported
nested properties with an error containing `Invalid session metadata order`.

- [ ] **Step 4: Enrich list output and clear detached positions**

Refactor `PiSessionService.list()` to load its gateway sessions, archive records,
and metadata snapshot once, then delegate the current reconciliation/enrichment
body to private `listFromSnapshots(cwd, sessions, archivedRecords, metadata)`.
The helper receives already-read values and must not call either store again.
Replace `mergeSessionMetadata` with:

```ts
function mergeSessionMetadata(
  session: ClientSession,
  metadata: Readonly<Record<string, SessionMetadata>>,
): ClientSession {
  const entry = metadata[session.path];
  const pinned = entry?.pinned === true;
  const scope: SessionReorderScope = session.parentSessionPath === undefined
    ? { kind: "root", cwd: canonicalizeStoredCwd(session.cwd) }
    : { kind: "children", parentSessionPath: session.parentSessionPath };
  const order = entry?.order;
  const manualOrder = order !== undefined
    && order.pinned === pinned
    && sessionReorderScopesEqual(order.scope, scope)
    ? order.position
    : undefined;
  return {
    ...session,
    ...(pinned ? { pinned: true } : {}),
    ...(manualOrder === undefined ? {} : { manualOrder }),
  };
}

function sessionReorderScopesEqual(a: SessionReorderScope, b: SessionReorderScope): boolean {
  if (a.kind === "root") return b.kind === "root" && a.cwd === b.cwd;
  return b.kind === "children" && a.parentSessionPath === b.parentSessionPath;
}
```

Call `metadataStore.clearOrder(sessionFile)` after
`clearParentSessionHeader()` succeeds in `detachParent()`. Existing
`pin()`/`unpin()` calls now clear order through the store and their fresh active
session responses naturally omit `manualOrder`.

Make the detach-order assertion written in Step 1 pass by clearing metadata only
after the persisted/runtime parent mutation succeeds.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
npm test -- --run src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.unread.test.ts src/client/src/sessionTreeRows.order.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/server/sessions/sessionMetadataStore.ts src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.unread.test.ts
npm run knip
```

Expected: all commands PASS. Pin-only files remain valid, mismatched signatures
do not leak positions, and no staged public method is unused.

- [ ] **Step 6: Commit**

```bash
git add src/shared/apiTypes.ts src/server/sessions/sessionMetadataStore.ts src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.unread.test.ts
git commit -m "feat(sessions): persist signed sibling order"
```

## Task 3: Add the strict daemon reorder protocol and capability

**Implementer tier:** Advanced

**Files:**

- Modify: `src/shared/apiTypes.ts:4-23,438-446`
- Modify: `src/shared/capabilities.ts:8-66`
- Modify: `src/shared/capabilities.test.ts:1-230`
- Modify: `src/shared/federatedRoutes.ts`
- Modify: `src/server/sessions/sessionMetadataStore.ts:14-105`
- Modify: `src/server/sessions/sessionMetadataStore.test.ts`
- Create: `src/server/sessions/sessionReorder.ts`
- Create: `src/server/sessions/sessionReorder.test.ts`
- Modify: `src/server/sessions/piSessionService.ts:23-90,1021-1150,1354-1470,3085-3320,3455-3484`
- Create: `src/server/sessions/piSessionService.order.test.ts`
- Modify: `src/server/sessions/sessionService.ts:1-93`
- Modify: `src/server/sessions/sessionRoutes.ts:1-55,137-153,516-745`
- Modify: `src/server/sessions/sessionRoutes.test.ts:1-35,900-1200`
- Modify: `src/server/sessiond/sessionProxyRoutes.test.ts:1-120`
- Modify: `src/server/app.remoteProxy.test.ts`

**Interfaces:**

- Consumes: `SessionReorderScope`, `SessionInfo.manualOrder?: number`,
  `SessionMetadataStore.snapshot(): Promise<Record<string, SessionMetadata>>`,
  `SessionMetadataStore.clearOrder(path): Promise<void>`, and signed
  `SessionOrderMetadata = { position; scope; pinned }`.
- Produces: capability constant
  `PI_WEBUI_CAPABILITIES.sessionsReorder = "sessions.reorder"` in both runtime
  capability lists and the `web + sessiond` requirement matrix.
- Produces: `SESSION_REORDER_LIMIT = 1_000`,
  `SESSION_REORDER_SESSION_ID_MAX_LENGTH = 512`,
  `SESSION_REORDER_CWD_MAX_LENGTH = 32 * 1024`, and
  `SESSION_REORDER_PARENT_PATH_MAX_LENGTH = 32 * 1024`,
  `SessionReorderRequest`, `SessionOrderEntry`, and
  `SessionReorderResponse` exactly as shown below.
- Produces: `SessionMetadataStore.replaceOrder(sessionPaths: readonly string[],
  scope: SessionReorderScope, pinned: boolean): Promise<void>` with an atomic
  expected-pin check.
- Produces: `validateSessionReorder(target: SessionRef, request:
  SessionReorderRequest, catalog: readonly SessionInfo[]):
  ValidatedSessionReorder` and `assertSubmittedSessionsCurrent(...)` in a pure
  server domain module.
- Produces: `PiSessionService.reorder(ref: SessionRouteRef, request:
  SessionReorderRequest): Promise<SessionReorderResponse>` and the same method on
  `SessionRouteService`.
- Produces: private `PiSessionService.listReorderCatalog(cwds)` that takes one
  metadata snapshot, one archive snapshot, and all gateway CWD lists for each
  complete before/after catalog read.
- Produces: strict `POST /sessions/:sessionId/reorder` with typed
  `400`/`404`/`409`/`500` behavior.
- Produces: `{ method: "POST", path: "/sessions/:sessionId/reorder" }` in
  `FEDERATED_HTTP_ROUTES`, so selected remote machines receive the same body.

- [ ] **Step 1: Write failing store, domain, capability, route, and proxy tests**

Expand the store-test filesystem imports to include `mkdir` and `readdir`, the
path imports to include `basename` and `dirname`, and import `vi`, then add the
atomic store tests:

```ts
it("atomically normalizes a complete group and preserves unrelated metadata", async () => {
  await store.pin("/pinned.jsonl");
  await store.replaceOrder(
    ["/second.jsonl", "/first.jsonl"],
    { kind: "root", cwd: "/repo" },
    false,
  );

  expect(await store.snapshot()).toEqual({
    "/pinned.jsonl": { pinned: true },
    "/second.jsonl": {
      order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
    "/first.jsonl": {
      order: { position: 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
    },
  });
});

it("rejects the whole batch when current pin metadata differs", async () => {
  await store.pin("/changed.jsonl");
  await expect(store.replaceOrder(
    ["/unchanged.jsonl", "/changed.jsonl"],
    { kind: "root", cwd: "/repo" },
    false,
  )).rejects.toThrow("Session pin state changed during reorder");
  expect(await store.get("/unchanged.jsonl")).toBeUndefined();
});

it("serializes complete batches with deterministic last-writer order", async () => {
  const first = store.replaceOrder(
    ["/first.jsonl", "/second.jsonl"],
    { kind: "root", cwd: "/repo" },
    false,
  );
  const second = store.replaceOrder(
    ["/second.jsonl", "/first.jsonl"],
    { kind: "root", cwd: "/repo" },
    false,
  );
  await Promise.all([first, second]);
  const snapshot = await store.snapshot();
  expect(snapshot["/second.jsonl"]?.order?.position).toBe(0);
  expect(snapshot["/first.jsonl"]?.order?.position).toBe(1);
});

it("removes the temporary file when the atomic rename fails", async () => {
  const renameFailure = vi.fn(async () => { throw new Error("rename failed"); });
  const failingStore = new SessionMetadataStore(filePath, {
    mkdir,
    readFile,
    writeFile,
    rename: renameFailure,
    unlink,
  });

  await expect(failingStore.replaceOrder(
    ["/first.jsonl"],
    { kind: "root", cwd: "/repo" },
    false,
  )).rejects.toThrow("rename failed");
  expect(renameFailure).toHaveBeenCalledOnce();
  const tempPrefix = `.${basename(filePath)}.`;
  expect((await readdir(dirname(filePath)))
    .filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp")))
    .toEqual([]);
  await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
```

Create `sessionReorder.test.ts` with this fixture shape and table:

```ts
import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionReorderRequest } from "../../shared/apiTypes";
import { assertSubmittedSessionsCurrent, SessionReorderDomainError, validateSessionReorder, type SessionReorderErrorKind } from "./sessionReorder";

function session(id: string, cwd: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: "",
    ...patch,
  };
}

const rootRequest: SessionReorderRequest = {
  cwd: "/repo",
  scope: { kind: "root", cwd: "/repo" },
  pinned: false,
  catalogCwds: ["/repo", "/feature"],
  orderedSessions: [
    { id: "second", cwd: "/repo" },
    { id: "first", cwd: "/repo" },
  ],
};

describe("validateSessionReorder", () => {
  it("returns paths and normalized response for a complete coherent group", () => {
    expect(validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [session("first", "/repo"), session("second", "/repo"), session("other", "/feature")],
    )).toEqual({
      sessionPaths: ["/sessions/second.jsonl", "/sessions/first.jsonl"],
      response: {
        orderedSessions: [
          { id: "second", cwd: "/repo", manualOrder: 0 },
          { id: "first", cwd: "/repo", manualOrder: 1 },
        ],
      },
    });
  });

  const staleCases: [SessionReorderErrorKind, SessionReorderRequest, SessionInfo[]][] = [
    ["invalid", { ...rootRequest, orderedSessions: [rootRequest.orderedSessions[0]!] }, [session("first", "/repo"), session("second", "/repo")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { pinned: true })]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { parentSessionPath: "/sessions/parent.jsonl" })]],
    ["conflict", { ...rootRequest, orderedSessions: [{ id: "second", cwd: "/feature" }, { id: "first", cwd: "/repo" }] }, [session("first", "/repo"), session("second", "/feature")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo"), session("omitted", "/repo")]],
    ["conflict", { ...rootRequest, scope: { kind: "root" as const, cwd: "/other" } }, [session("first", "/repo"), session("second", "/repo")]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { archived: true })]],
    ["conflict", rootRequest, [session("first", "/repo"), session("second", "/repo", { persisted: false })]],
    ["conflict", rootRequest, [session("first", "/repo", { persisted: false }), session("second", "/repo")]],
  ];

  it.each(staleCases)("reports %s for invalid or stale group state", (kind, request, catalog) => {
    try {
      validateSessionReorder({ id: "first", cwd: "/repo" }, request, catalog);
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionReorderDomainError);
      expect((error as SessionReorderDomainError).kind).toBe(kind);
    }
  });

  it("reports not-found for an unresolved ordered identity", () => {
    expect(() => validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [session("first", "/repo")],
    )).toThrowError(expect.objectContaining({ kind: "not-found" }));
  });

  it("rejects distinct identities that resolve to one persisted path", () => {
    expect(() => validateSessionReorder(
      { id: "first", cwd: "/repo" },
      rootRequest,
      [
        session("first", "/repo"),
        { ...session("second", "/repo"), path: "/sessions/first.jsonl" },
      ],
    )).toThrowError(expect.objectContaining({ kind: "invalid" }));
  });
});
```

Add the cross-workspace child and post-write tests:

```ts
it("accepts cross-workspace children only under the exact same parent", () => {
  const parentSessionPath = "/sessions/parent.jsonl";
  const request: SessionReorderRequest = {
    cwd: "/repo",
    scope: { kind: "children", parentSessionPath },
    pinned: false,
    catalogCwds: ["/repo", "/feature"],
    orderedSessions: [
      { id: "feature-child", cwd: "/feature" },
      { id: "main-child", cwd: "/repo" },
    ],
  };
  expect(validateSessionReorder(
    { id: "main-child", cwd: "/repo" },
    request,
    [
      session("main-child", "/repo", { parentSessionPath }),
      session("feature-child", "/feature", { parentSessionPath }),
    ],
  ).response.orderedSessions).toEqual([
    { id: "feature-child", cwd: "/feature", manualOrder: 0 },
    { id: "main-child", cwd: "/repo", manualOrder: 1 },
  ]);
});

it("post-write checks submitted members but allows a new unordered sibling", () => {
  expect(() => assertSubmittedSessionsCurrent(
    { id: "first", cwd: "/repo" },
    rootRequest,
    [
      session("first", "/repo"),
      session("second", "/repo"),
      session("new", "/repo"),
    ],
  )).not.toThrow();
  expect(() => assertSubmittedSessionsCurrent(
    { id: "first", cwd: "/repo" },
    rootRequest,
    [
      session("first", "/repo"),
      session("second", "/repo", { pinned: true }),
    ],
  )).toThrowError(expect.objectContaining({ kind: "conflict" }));
});
```

Add one capability test:

```ts
it("requires web and session daemon support for session reordering", () => {
  const reorder = PI_WEBUI_CAPABILITIES.sessionsReorder;
  expect(reorder).toBe("sessions.reorder");
  expect(WEB_RUNTIME_CAPABILITIES).toContain(reorder);
  expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(reorder);
  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [reorder] },
    sessiond: { available: true, capabilities: [] },
  })).not.toContain(reorder);
  expect(effectivePiWebUiCapabilities({
    web: { available: true, capabilities: [reorder] },
    sessiond: { available: true, capabilities: [reorder] },
  })).toContain(reorder);
});
```

In `sessionRoutes.test.ts`, import the reorder types/domain error and add these
members to `CapturingRouteSessionService`:

```ts
readonly reorderCalls: { ref: SessionRouteRef; request: SessionReorderRequest }[] = [];
reorderError: unknown | undefined;

reorder(ref: SessionRouteRef, request: SessionReorderRequest): Promise<SessionReorderResponse> {
  this.reorderCalls.push({ ref, request });
  if (this.reorderError !== undefined) return Promise.reject(this.reorderError);
  return Promise.resolve({
    orderedSessions: request.orderedSessions.map((entry, manualOrder) => ({
      ...entry,
      manualOrder,
    })),
  });
}
```

Follow the existing nested route-fixture pattern: each reorder route test creates
`routeApp`, registers `fastifyWebsocket`, creates a
`CapturingRouteSessionService`, calls `registerSessionRoutes`, and closes both in
`finally`. Do not use the file's top-level real `app`/`service` fixture for these
capturing/error assertions. Inside one nested malformed-request test, use:

```ts
it("rejects malformed reorder requests before calling the service", async () => {
  const routeApp = Fastify({ logger: false });
  await routeApp.register(fastifyWebsocket);
  const eventHub = new SessionEventHub();
  const routeService = new CapturingRouteSessionService();
  registerSessionRoutes(routeApp, routeService, eventHub);
  try {
const validReorderBody = {
  cwd: "/repo",
  scope: { kind: "root", cwd: "/repo" },
  pinned: false,
  catalogCwds: ["/repo"],
  orderedSessions: [
    { id: "s-1", cwd: "/repo" },
    { id: "s-2", cwd: "/repo" },
  ],
};
const oversizedId = "x".repeat(SESSION_REORDER_SESSION_ID_MAX_LENGTH + 1);
const oversizedPath = `/${"x".repeat(SESSION_REORDER_CWD_MAX_LENGTH)}`;
const oversizedParentPath = `/${"x".repeat(SESSION_REORDER_PARENT_PATH_MAX_LENGTH)}`;

const malformed: {
  name: string;
  url: string;
  body: unknown;
  expectedError?: string;
}[] = [
  { name: "empty catalogs", url: "/sessions/s-1/reorder", body: { ...validReorderBody, catalogCwds: [] } },
  { name: "empty order", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [] } },
  { name: "request property", url: "/sessions/s-1/reorder", body: { ...validReorderBody, extra: true } },
  { name: "scope property", url: "/sessions/s-1/reorder", body: { ...validReorderBody, scope: { kind: "root", cwd: "/repo", extra: true } } },
  { name: "ref property", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-1", cwd: "/repo", extra: true }] } },
  { name: "pin type", url: "/sessions/s-1/reorder", body: { ...validReorderBody, pinned: "false" } },
  { name: "catalog entry type", url: "/sessions/s-1/reorder", body: { ...validReorderBody, catalogCwds: [1] } },
  { name: "empty ref id", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "", cwd: "/repo" }] } },
  { name: "scope kind", url: "/sessions/s-1/reorder", body: { ...validReorderBody, scope: { kind: "future", cwd: "/repo" } } },
  { name: "empty parent path", url: "/sessions/s-1/reorder", body: { ...validReorderBody, scope: { kind: "children", parentSessionPath: "" } } },
  { name: "normalized catalog duplicate", url: "/sessions/s-1/reorder", body: { ...validReorderBody, catalogCwds: ["/repo", "/repo/."] } },
  { name: "ref duplicate", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-1", cwd: "/repo" }, { id: "s-1", cwd: "/repo" }] } },
  { name: "ref outside catalog", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-1", cwd: "/other" }] } },
  { name: "target omitted", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-2", cwd: "/repo" }] } },
  { name: "catalog limit", url: "/sessions/s-1/reorder", body: { ...validReorderBody, catalogCwds: ["/repo", ...Array.from({ length: 1_000 }, (_, index) => `/catalog-${index}`)] } },
  { name: "order limit", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-1", cwd: "/repo" }, ...Array.from({ length: 1_000 }, (_, index) => ({ id: `extra-${index}`, cwd: "/repo" }))] } },
  { name: "URL id bound", url: `/sessions/${oversizedId}/reorder`, body: validReorderBody, expectedError: "sessionId field is too long" },
  { name: "top-level CWD bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, cwd: oversizedPath }, expectedError: "cwd field is too long" },
  { name: "root-scope CWD bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, scope: { kind: "root", cwd: oversizedPath } }, expectedError: "scope.cwd field is too long" },
  { name: "catalog CWD bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, catalogCwds: [oversizedPath] }, expectedError: "catalogCwds[0] field is too long" },
  { name: "ref id bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: oversizedId, cwd: "/repo" }] }, expectedError: "orderedSessions[0].id field is too long" },
  { name: "ref CWD bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, orderedSessions: [{ id: "s-1", cwd: oversizedPath }] }, expectedError: "orderedSessions[0].cwd field is too long" },
  { name: "parent path bound", url: "/sessions/s-1/reorder", body: { ...validReorderBody, scope: { kind: "children", parentSessionPath: oversizedParentPath } }, expectedError: "scope.parentSessionPath field is too long" },
];

for (const request of malformed) {
  const response = await routeApp.inject({ method: "POST", url: request.url, payload: request.body });
  expect(response.statusCode, request.name).toBe(400);
  if (request.expectedError !== undefined) expect(response.body).toContain(request.expectedError);
}
expect(routeService.reorderCalls).toEqual([]);
  } finally {
    await routeService.dispose();
    await routeApp.close();
  }
});
```

In a second nested fixture, loop over a mutable
`[error: unknown, statusCode: number][]` containing invalid/not-found/conflict
domain errors and an ordinary write error. Set `routeService.reorderError`,
inject the valid body, and assert `400`/`404`/`409`/`500` respectively. Avoid a
deep `as const` assertion on mutable protocol objects.

Test one canonical child request separately. Its success assertion must be:

```ts
expect(routeService.reorderCalls).toEqual([{
  ref: { id: "s-1", cwd: resolve("/repo") },
  request: {
    cwd: resolve("/repo"),
    scope: { kind: "children", parentSessionPath: "/sessions/parent.jsonl" },
    pinned: false,
    catalogCwds: [resolve("/repo"), resolve("/feature")],
    orderedSessions: [
      { id: "s-2", cwd: resolve("/feature") },
      { id: "s-1", cwd: resolve("/repo") },
    ],
  },
}]);
```

In `sessionProxyRoutes.test.ts`, post the same body through
`/api/machines/local/sessions/s-1/reorder` and assert the daemon receives
`{ method: "POST", path: "/sessions/s-1/reorder", body }` unchanged.

In `app.remoteProxy.test.ts`, follow the existing remote reload test and add:

```ts
it("proxies remote session reorder bodies through the selected machine", async () => {
  const addResponse = await appTestContext.app.inject({
    method: "POST",
    url: "/api/machines",
    payload: { name: "Remote", baseUrl: "https://remote.example.test/" },
  });
  const remote = addResponse.json<{ id: string }>();
  const request = vi.fn<MachineClient["request"]>((method, path, body) => Promise.resolve({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: Readable.from([JSON.stringify({ method, path, body })]),
  }));
  appTestContext.remoteClient = fakeRemoteClient({ request });
  const body = {
    cwd: "/repo",
    scope: { kind: "root", cwd: "/repo" },
    pinned: false,
    catalogCwds: ["/repo"],
    orderedSessions: [
      { id: "s-2", cwd: "/repo" },
      { id: "s-1", cwd: "/repo" },
    ],
  };

  const response = await appTestContext.app.inject({
    method: "POST",
    url: `/api/machines/${remote.id}/sessions/s-1/reorder`,
    payload: body,
  });

  expect(response.statusCode).toBe(200);
  expect(request).toHaveBeenCalledWith(
    "POST",
    "/api/sessions/s-1/reorder",
    body,
  );
});
```

Create `piSessionService.order.test.ts` with the same temporary gateway/runtime
harness used by adjacent Pi-session service tests. Add root and cross-workspace
child success, exact-group conflicts, pin-conflict conversion, post-write
concurrent-creation acceptance, queued pin/detach/archive/cleanup behavior, and
archive-then-restore preservation of a same-scope signed position. Use deferred
metadata-store/list gateway operations to prove each related mutation does not
enter its critical body until reorder releases the queue. Include one cleanup
plan with a current archive candidate and prove its `closeActive`/archive-store
mutation waits. After restore, list the original CWD and assert the matching
`manualOrder` is emitted again. In the cross-workspace success test, spy on
`metadataStore.snapshot()` and `archiveStore.list()` and assert each is called
exactly twice total: once for the complete before catalog and once for the
complete after catalog, never once per CWD.

- [ ] **Step 2: Run the focused tests and confirm red failures**

Run:

```bash
npm test -- --run src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/sessionReorder.test.ts src/server/sessions/piSessionService.order.test.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.archiveCleanup.test.ts src/shared/capabilities.test.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts
```

Expected: FAIL because the request contracts, validator, atomic batch, route,
service method, and capability do not exist.

- [ ] **Step 3: Add the shared protocol and pure validation module**

Add to `PI_WEBUI_CAPABILITIES` and beside the shared session contracts:

```ts
sessionsReorder: "sessions.reorder",

export const SESSION_REORDER_LIMIT = 1_000;
export const SESSION_REORDER_SESSION_ID_MAX_LENGTH = 512;
export const SESSION_REORDER_CWD_MAX_LENGTH = 32 * 1024;
export const SESSION_REORDER_PARENT_PATH_MAX_LENGTH = 32 * 1024;

export interface SessionReorderRequest {
  cwd: string;
  scope: SessionReorderScope;
  pinned: boolean;
  catalogCwds: string[];
  orderedSessions: SessionRef[];
}

export interface SessionOrderEntry extends SessionRef {
  manualOrder: number;
}

export interface SessionReorderResponse {
  orderedSessions: SessionOrderEntry[];
}
```

Implement `sessionReorder.ts` as a pure module with:

```ts
export type SessionReorderErrorKind = "invalid" | "not-found" | "conflict";

export class SessionReorderDomainError extends Error {
  constructor(readonly kind: SessionReorderErrorKind, message: string) {
    super(message);
    this.name = "SessionReorderDomainError";
  }
}

export interface ValidatedSessionReorder {
  sessionPaths: string[];
  response: SessionReorderResponse;
}

export function validateSessionReorder(
  target: SessionRef,
  request: SessionReorderRequest,
  catalog: readonly SessionInfo[],
): ValidatedSessionReorder;

export function assertSubmittedSessionsCurrent(
  target: SessionRef,
  request: SessionReorderRequest,
  catalog: readonly SessionInfo[],
): void;
```

Use `JSON.stringify([cwd, id])` for identity keys. The initial validator must:

1. reject target omission as `invalid`;
2. resolve every ordered ref or report `not-found`;
3. reject archived/transient/scope/pin mismatches as `conflict`;
4. derive the eligible group from the full catalog and require exact identity-set
   equality;
5. reject different refs that resolve to one path;
6. return paths and `manualOrder` values in request order.

The post-write assertion repeats submitted-member existence, persistence,
archive, scope, and pin checks but intentionally allows newly added eligible
sessions so a concurrent create remains unordered at the top.

- [ ] **Step 4: Implement the atomic store write and service orchestration**

Add a typed store conflict and one complete exclusive operation:

```ts
export class SessionMetadataOrderConflictError extends Error {
  constructor() {
    super("Session pin state changed during reorder");
    this.name = "SessionMetadataOrderConflictError";
  }
}

async replaceOrder(
  sessionPaths: readonly string[],
  scope: SessionReorderScope,
  pinned: boolean,
): Promise<void> {
  await this.exclusive(async () => {
    const data = await this.read();
    if (sessionPaths.some((path) => (data[path]?.pinned === true) !== pinned)) {
      throw new SessionMetadataOrderConflictError();
    }
    sessionPaths.forEach((path, position) => {
      data[path] = { ...data[path], order: { position, scope, pinned } };
    });
    await this.write(data);
  });
}
```

In `PiSessionService`, add one serialized ordering queue used by `reorder`,
`pin`, `unpin`, `detachParent`, `archive`, `archiveMany`, `archiveTree`, and
`restore`, plus cleanup execution that archives current sessions, so metadata,
lineage, and current/archive membership cannot interleave:

```ts
private sessionOrderMutationQueue: Promise<void> = Promise.resolve();

private async runSessionOrderMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = this.sessionOrderMutationQueue;
  let release = (): void => undefined;
  this.sessionOrderMutationQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}
```

Implement `reorder` inside that queue:

```ts
async reorder(ref: SessionRouteRef, request: SessionReorderRequest): Promise<SessionReorderResponse> {
  return await this.runSessionOrderMutation(async () => {
    const target = { id: ref.id, cwd: canonicalizeStoredCwd(ref.cwd) };
    const before = await this.listReorderCatalog(request.catalogCwds);
    const validated = validateSessionReorder(target, request, uniqueSessionsByIdentity(before));
    try {
      await this.metadataStore.replaceOrder(validated.sessionPaths, request.scope, request.pinned);
    } catch (error: unknown) {
      if (error instanceof SessionMetadataOrderConflictError) {
        throw new SessionReorderDomainError("conflict", error.message);
      }
      throw error;
    }
    const after = await this.listReorderCatalog(request.catalogCwds);
    assertSubmittedSessionsCurrent(target, request, uniqueSessionsByIdentity(after));
    return validated.response;
  });
}
```

Implement the coherent loader without routing through public `list()`:

```ts
private async listReorderCatalog(cwds: readonly string[]): Promise<ClientSession[]> {
  const metadataPromise = this.metadataStore.snapshot();
  const archivePromise = this.archiveStore.list();
  const sessionListsPromise = Promise.all(cwds.map((cwd) => this.sessionManager.list(cwd)));
  const [metadata, archivedRecords, sessionLists] = await Promise.all([
    metadataPromise,
    archivePromise,
    sessionListsPromise,
  ]);
  return (await Promise.all(cwds.map((cwd, index) => this.listFromSnapshots(
    cwd,
    sessionLists[index] ?? [],
    archivedRecords,
    metadata,
  )))).flat();
}
```

`listFromSnapshots()` remains the sole owner of archive reconciliation,
workspace activity, unread reconciliation, and metadata enrichment. One loader
call is one coherent metadata/archive view even though gateway CWD reads run in
parallel.

Implement `uniqueSessionsByIdentity()` locally using canonical CWD + id and make
the last record win, matching other catalog reconciliation helpers. Wrap the
existing bodies of pin/unpin/detach/archive/archiveMany/archiveTree/restore in
`runSessionOrderMutation`, and wrap the full `cleanup()` plan-and-execute body as
well. `cleanupPreview()` stays read-only and `forceCleanup()` deletes only
already-archived records, so neither needs this queue. Do not block reordering
merely because a session is streaming. Keep each existing archive
tree-exclusivity check inside the queue.
The metadata-store pin recheck remains the final guard before persistence.

- [ ] **Step 5: Add the strict route, capability matrix, and proxy coverage**

Add `reorder(ref, request)` to `SessionRouteService`. Register:

```ts
app.post<{ Params: { sessionId: string }; Body: unknown }>(
  `${prefix}/sessions/:sessionId/reorder`,
  async (request, reply) => {
    let parsed: SessionReorderRequest;
    let sessionId: string;
    try {
      sessionId = requireNonEmptyBoundedString(
        request.params.sessionId,
        "sessionId",
        SESSION_REORDER_SESSION_ID_MAX_LENGTH,
      );
      parsed = sessionReorderRequestFromUnknown(request.body);
      if (!parsed.orderedSessions.some((entry) => (
        entry.id === sessionId && entry.cwd === parsed.cwd
      ))) throw new Error("orderedSessions must contain the URL target");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
    try {
      return await sessions.reorder(
        { id: sessionId, cwd: parsed.cwd },
        parsed,
      );
    } catch (error) {
      return reply.code(sessionReorderErrorStatus(error)).send({ error: errorMessage(error) });
    }
  },
);
```

`sessionReorderRequestFromUnknown()` must use `requireExactFields()` for the
request, scope, and every ordered ref. Before normalization or membership
checks, apply `requireNonEmptyBoundedString()` with
`SESSION_REORDER_CWD_MAX_LENGTH` independently to top-level `cwd`, root-scope
`cwd`, every `catalogCwds[index]`, and every
`orderedSessions[index].cwd`; apply `SESSION_REORDER_SESSION_ID_MAX_LENGTH` to
the URL id and every ordered id, and `SESSION_REORDER_PARENT_PATH_MAX_LENGTH` to
the child parent path. Use indexed field labels so each bound test proves the
intended nested parser. Normalize all CWDs; reject empty arrays, more than
`SESSION_REORDER_LIMIT`, duplicates after normalization, target CWDs outside
`catalogCwds`, empty parent paths, and unsupported scope kinds. Map
`SessionReorderDomainError.kind` to `400`, `404`, or `409`; map every unknown
error to `500`.

Add `sessionsReorder` to `WEB_RUNTIME_CAPABILITIES`,
`SESSIOND_RUNTIME_CAPABILITIES`, and `EFFECTIVE_CAPABILITY_REQUIREMENTS` with
`["web", "sessiond"]`. Add
`{ method: "POST", path: "/sessions/:sessionId/reorder" }` beside the other
session mutations in `FEDERATED_HTTP_ROUTES`. The local session-daemon proxy
needs no production change because its wildcard already forwards the body; the
remote selected-machine proxy is allowlisted and therefore requires this new
route spec.

- [ ] **Step 6: Run backend protocol verification**

Run:

```bash
npm test -- --run src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/sessionReorder.test.ts src/server/sessions/piSessionService.order.test.ts src/server/sessions/piSessionService.orderMetadata.test.ts src/server/sessions/piSessionService.archiveCleanup.test.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts src/shared/capabilities.test.ts
npm run typecheck
npx eslint src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/shared/federatedRoutes.ts src/server/sessions/sessionMetadataStore.ts src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/sessionReorder.ts src/server/sessions/sessionReorder.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.order.test.ts src/server/sessions/sessionService.ts src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts
npm run knip
```

Expected: all commands PASS. The route test observes all four status families,
the proxy preserves the body, and capability intersection withholds support from
mixed runtimes.

- [ ] **Step 7: Commit**

```bash
git add src/shared/apiTypes.ts src/shared/capabilities.ts src/shared/capabilities.test.ts src/shared/federatedRoutes.ts src/server/sessions/sessionMetadataStore.ts src/server/sessions/sessionMetadataStore.test.ts src/server/sessions/sessionReorder.ts src/server/sessions/sessionReorder.test.ts src/server/sessions/piSessionService.ts src/server/sessions/piSessionService.order.test.ts src/server/sessions/sessionService.ts src/server/sessions/sessionRoutes.ts src/server/sessions/sessionRoutes.test.ts src/server/sessiond/sessionProxyRoutes.test.ts src/server/app.remoteProxy.test.ts
git commit -m "feat(sessions): add durable reorder protocol"
```

## Task 4: Add the browser API and optimistic session-controller mutation

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/api.ts:1-8`
- Modify: `src/client/src/api/parsers.ts:1-20,193-215,618-621`
- Modify: `src/client/src/api/parsers.test.ts:1-8,462-490`
- Modify: `src/client/src/api/clients.ts:1-80,292-352`
- Modify: `src/client/src/api/clients.test.ts:450-520`
- Modify: `src/client/src/api/federatedRouteContract.test.ts:130-175`
- Modify: `src/client/src/controllers/sessionController.ts:1-230,883-1001,1378-1389`
- Create: `src/client/src/controllers/sessionController.reorder.test.ts`

**Interfaces:**

- Consumes: `SessionReorderRequest`, `SessionOrderEntry`,
  `SessionReorderResponse`, `SessionInfo.manualOrder`, and
  `POST api/machines/:machineId/sessions/:sessionId/reorder`.
- Produces: `parseSessionReorderResponse(value: unknown):
  SessionReorderResponse` with strict non-negative safe positions.
- Produces: `sessionsApi.reorder(session: SessionRef, input:
  SessionReorderRequest, machineId?: string): Promise<SessionReorderResponse>`.
- Produces: `SessionController.reorderSession(session: SessionInfo, input:
  SessionReorderRequest): Promise<void>`.
- Produces: optional dependency
  `refreshProjectSessionCatalog?: () => void | Promise<void>` for authoritative
  recovery after an ambiguous failure.
- Produces: pure file-local `applySessionOrderEntries(sessions, entries):
  SessionInfo[]`, matching by canonical CWD + id and updating only submitted
  entries, plus `captureSessionOrderEntries()`/`restoreSessionOrderEntries()`
  that roll back only `manualOrder` without clobbering concurrent catalog data.

- [ ] **Step 1: Write failing API and controller tests**

Extend `parsers.test.ts` imports and add:

```ts
it("parses strict normalized session reorder responses", () => {
  expect(parseSessionReorderResponse({
    orderedSessions: [
      { id: "second", cwd: "/repo", manualOrder: 0 },
      { id: "first", cwd: "/repo", manualOrder: 1 },
    ],
  })).toEqual({
    orderedSessions: [
      { id: "second", cwd: "/repo", manualOrder: 0 },
      { id: "first", cwd: "/repo", manualOrder: 1 },
    ],
  });
  expect(() => parseSessionReorderResponse({
    orderedSessions: [{ id: "first", cwd: "/repo", manualOrder: -1 }],
  })).toThrow("Expected non-negative safe integer field: manualOrder");
});
```

Add an encoded client test:

```ts
it("posts a complete reorder through the selected machine", async () => {
  const response = { orderedSessions: [{ id: "s /?", cwd: "/repo", manualOrder: 0 }] };
  const fetchMock = stubJsonFetch(response);
  const input = {
    cwd: "/repo",
    scope: { kind: "root" as const, cwd: "/repo" },
    pinned: false,
    catalogCwds: ["/repo"],
    orderedSessions: [{ id: "s /?", cwd: "/repo" }],
  };

  await expect(sessionsApi.reorder({ id: "s /?", cwd: "/repo" }, input, "remote /?"))
    .resolves.toEqual(response);

  const [url, init] = fetchCall(fetchMock, 0);
  expect(url).toBe("https://pi.example.test/api/machines/remote%20%2F%3F/sessions/s%20%2F%3F/reorder");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(requestBody(init))).toEqual(input);
});
```

Add the call to `federatedRouteContract.test.ts` and require the resulting route
set to contain `POST sessions/:sessionId/reorder` under the nested application
base.

Create `sessionController.reorder.test.ts` using `initialAppState()`,
`deferred()`, `FakeSocket`, and the following complete harness and tests:

```ts
const first = session("first");
const second = session("second");

function session(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: id,
    ...patch,
  };
}

function request(order: readonly SessionInfo[]): SessionReorderRequest {
  return {
    cwd: first.cwd,
    scope: { kind: "root", cwd: first.cwd },
    pinned: false,
    catalogCwds: [first.cwd],
    orderedSessions: order.map(({ id, cwd }) => ({ id, cwd })),
  };
}

function createHarness(
  apiPatch: Partial<typeof defaultApi>,
  refreshProjectSessionCatalog: () => void | Promise<void> = () => undefined,
) {
  let state: AppState = {
    ...initialAppState(),
    selectedWorkspace: workspace,
    selectedSession: first,
    sessions: [first, second],
    projectSessions: [first, second],
  };
  const api: typeof defaultApi = { ...defaultApi, ...apiPatch };
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), refreshProjectSessionCatalog },
  );
  return {
    controller,
    state: () => state,
    mutateState: (mutate: (current: AppState) => AppState) => { state = mutate(state); },
  };
}

it("optimistically updates every catalog and merges the authoritative response", async () => {
  const pending = deferred<SessionReorderResponse>();
  const reorder = vi.fn(() => pending.promise);
  const harness = createHarness({ reorder });
  const running = harness.controller.reorderSession(first, request([second, first]));

  expect(harness.state().sessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
    ["first", 1], ["second", 0],
  ]);
  expect(harness.state().projectSessions.map(({ id, manualOrder }) => [id, manualOrder])).toEqual([
    ["first", 1], ["second", 0],
  ]);
  expect(harness.state().selectedSession).toMatchObject({ id: "first", manualOrder: 1 });

  pending.resolve({ orderedSessions: [
    { id: "second", cwd: "/repo", manualOrder: 4 },
    { id: "first", cwd: "/repo", manualOrder: 5 },
  ] });
  await running;
  expect(harness.state().selectedSession).toMatchObject({ id: "first", manualOrder: 5 });
});

it("allows one in-flight reorder and recovers failed or ambiguous commits from catalogs", async () => {
  const pending = deferred<SessionReorderResponse>();
  const reorder = vi.fn(() => pending.promise);
  const sessions = vi.fn(() => Promise.resolve([first, { ...second, manualOrder: 0 }]));
  const refreshProjectSessionCatalog = vi.fn(() => Promise.resolve());
  const harness = createHarness({ reorder, sessions }, refreshProjectSessionCatalog);

  const firstRun = harness.controller.reorderSession(first, request([second, first]));
  await harness.controller.reorderSession(first, request([first, second]));
  expect(reorder).toHaveBeenCalledOnce();
  pending.reject(new Error("response lost"));
  await firstRun;

  expect(sessions).toHaveBeenCalledWith("/repo", "local");
  expect(refreshProjectSessionCatalog).toHaveBeenCalledOnce();
  expect(harness.state().error).toContain("response lost");
});

it("ignores an authoritative completion after the workspace changes", async () => {
  const pending = deferred<SessionReorderResponse>();
  const harness = createHarness({ reorder: () => pending.promise });
  const running = harness.controller.reorderSession(first, request([second, first]));
  const otherWorkspace: Workspace = { ...workspace, id: "other", path: "/other" };
  const other = session("other", "/other");
  harness.mutateState((state) => ({
    ...state,
    selectedWorkspace: otherWorkspace,
    selectedSession: other,
    sessions: [other],
    projectSessions: [other],
  }));

  pending.resolve({ orderedSessions: [
    { id: "second", cwd: "/repo", manualOrder: 0 },
    { id: "first", cwd: "/repo", manualOrder: 1 },
  ] });
  await running;

  expect(harness.state().selectedSession).toEqual(other);
  expect(harness.state().sessions).toEqual([other]);
});

it("rolls back only order fields when recovery refreshes also fail", async () => {
  const pending = deferred<SessionReorderResponse>();
  const sessions = vi.fn(() => Promise.reject(new Error("workspace refresh failed")));
  const refreshProjectSessionCatalog = vi.fn(() => Promise.reject(new Error("project refresh failed")));
  const harness = createHarness({ reorder: () => pending.promise, sessions }, refreshProjectSessionCatalog);
  const orderedFirst = { ...first, manualOrder: 7 };
  harness.mutateState((state) => ({
    ...state,
    sessions: [orderedFirst, second],
    projectSessions: [orderedFirst, second],
    selectedSession: orderedFirst,
  }));
  const running = harness.controller.reorderSession(orderedFirst, request([second, orderedFirst]));
  const extra = session("extra");
  harness.mutateState((state) => ({
    ...state,
    sessions: [
      ...state.sessions.map((item) => item.id === first.id ? { ...item, name: "Renamed concurrently" } : item),
      extra,
    ],
    projectSessions: [
      ...state.projectSessions.map((item) => item.id === first.id ? { ...item, name: "Renamed concurrently" } : item),
      extra,
    ],
    selectedSession: state.selectedSession === undefined
      ? undefined
      : { ...state.selectedSession, name: "Renamed concurrently" },
  }));

  pending.reject(new Error("response lost"));
  await running;

  const restoredFirst = harness.state().sessions.find(({ id }) => id === first.id);
  const restoredSecond = harness.state().sessions.find(({ id }) => id === second.id);
  expect(restoredFirst).toMatchObject({ name: "Renamed concurrently", manualOrder: 7 });
  expect(restoredSecond).not.toHaveProperty("manualOrder");
  expect(harness.state().sessions).toContain(extra);
  expect(harness.state().projectSessions).toContain(extra);
  expect(harness.state().selectedSession).toMatchObject({
    name: "Renamed concurrently",
    manualOrder: 7,
  });
  expect(sessions).toHaveBeenCalledOnce();
  expect(refreshProjectSessionCatalog).toHaveBeenCalledOnce();
});

it("removes a child's manual order after detaching it", async () => {
  const detachParent = vi.fn(() => Promise.resolve({ detached: true as const }));
  const child = {
    ...first,
    parentSessionPath: "/sessions/parent.jsonl",
    manualOrder: 3,
  };
  const harness = createHarness({ detachParent });
  harness.mutateState((state) => ({
    ...state,
    sessions: [child, second],
    projectSessions: [child, second],
    selectedSession: child,
  }));

  await harness.controller.detachParent(child);

  expect(detachParent).toHaveBeenCalledWith(child, "local");
  expect(harness.state().selectedSession).not.toHaveProperty("parentSessionPath");
  expect(harness.state().selectedSession).not.toHaveProperty("manualOrder");
  expect(harness.state().sessions.find(({ id }) => id === child.id))
    .not.toHaveProperty("manualOrder");
  expect(harness.state().projectSessions.find(({ id }) => id === child.id))
    .not.toHaveProperty("manualOrder");
});
```

Import `Workspace` and `AppState` as types. The workspace-switch case exercises
the explicit workspace guard; existing selection-sequence tests continue to
cover sequence increments.

- [ ] **Step 2: Run the browser-contract tests and confirm red failures**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/sessionController.reorder.test.ts
```

Expected: FAIL because parser, API method, federated route, controller method,
optimistic helper, and recovery dependency are absent.

- [ ] **Step 3: Implement the strict browser API**

Export `SessionReorderScope`, `SessionReorderRequest`, `SessionOrderEntry`, and
`SessionReorderResponse` as types from `src/client/src/api.ts`.
Implement:

```ts
function parseSessionOrderEntry(value: unknown): SessionOrderEntry {
  const record = requireRecord(value);
  return {
    id: requireString(record, "id"),
    cwd: requireString(record, "cwd"),
    manualOrder: requireNonNegativeSafeInteger(record, "manualOrder"),
  };
}

export function parseSessionReorderResponse(value: unknown): SessionReorderResponse {
  const record = requireRecord(value);
  return { orderedSessions: arrayOf(parseSessionOrderEntry)(record["orderedSessions"]) };
}
```

Add to `sessionsApi`:

```ts
reorder: (session: SessionRef, input: SessionReorderRequest, machineId = "local") =>
  request(sessionPath(session, "reorder", machineId), parseSessionReorderResponse, {
    method: "POST",
    body: JSON.stringify(input),
  }),
```

Do not merge `sessionBody()` into the request: `SessionReorderRequest.cwd` is
already required and the exact strict body must reach the route unchanged.

- [ ] **Step 4: Implement optimistic controller state and guarded recovery**

Add dependency/property state:

```ts
refreshProjectSessionCatalog?: () => void | Promise<void>;

private readonly refreshProjectSessionCatalog: NonNullable<SessionControllerDependencies["refreshProjectSessionCatalog"]>;
private sessionReorderInFlight = false;

this.refreshProjectSessionCatalog = deps.refreshProjectSessionCatalog ?? (() => undefined);
```

Implement the mutation with a captured `selectionSeq`, machine id, workspace id,
and per-projection prior order entries. Use request order for optimistic entries,
call `api.reorder`, and apply the response only if all captured scope values
still match. On failure in the same scope, restore only submitted order fields
against the current state, set `error`, then run both refreshes with
`Promise.allSettled()`:

```ts
async reorderSession(session: SessionInfo, input: SessionReorderRequest): Promise<void> {
  if (this.sessionReorderInFlight || session.archived === true || session.persisted !== true) return;
  const before = this.getState();
  const machineId = selectedMachineId(before);
  const workspaceId = before.selectedWorkspace?.id;
  const selectionSeq = this.selectionSeq;
  const optimistic = input.orderedSessions.map((ref, manualOrder) => ({ ...ref, manualOrder }));
  const priorSessionOrders = captureSessionOrderEntries(before.sessions, input.orderedSessions);
  const priorProjectOrders = captureSessionOrderEntries(before.projectSessions, input.orderedSessions);
  const priorSelectedOrder = captureSessionOrderEntries(
    before.selectedSession === undefined ? [] : [before.selectedSession],
    input.orderedSessions,
  );
  this.sessionReorderInFlight = true;
  this.setState({
    sessions: applySessionOrderEntries(before.sessions, optimistic),
    projectSessions: applySessionOrderEntries(before.projectSessions, optimistic),
    selectedSession: before.selectedSession === undefined
      ? undefined
      : applySessionOrderEntries([before.selectedSession], optimistic)[0],
  });
  try {
    const response = await this.api.reorder(session, input, machineId);
    if (!this.isCurrentSessionOrderScope(machineId, workspaceId, selectionSeq)) return;
    const state = this.getState();
    this.setState({
      sessions: applySessionOrderEntries(state.sessions, response.orderedSessions),
      projectSessions: applySessionOrderEntries(state.projectSessions, response.orderedSessions),
      selectedSession: state.selectedSession === undefined
        ? undefined
        : applySessionOrderEntries([state.selectedSession], response.orderedSessions)[0],
    });
  } catch (error) {
    if (!this.isCurrentSessionOrderScope(machineId, workspaceId, selectionSeq)) return;
    const state = this.getState();
    this.setState({
      sessions: restoreSessionOrderEntries(state.sessions, priorSessionOrders),
      projectSessions: restoreSessionOrderEntries(state.projectSessions, priorProjectOrders),
      selectedSession: state.selectedSession === undefined
        ? undefined
        : restoreSessionOrderEntries([state.selectedSession], priorSelectedOrder)[0],
      error: `Reorder failed: ${errorMessage(error)}`,
    });
    await Promise.allSettled([
      this.refreshCurrentWorkspaceSessions(machineId),
      Promise.resolve().then(() => this.refreshProjectSessionCatalog()),
    ]);
  } finally {
    this.sessionReorderInFlight = false;
  }
}
```

Implement `isCurrentSessionOrderScope()` using machine id, workspace id, and
`selectionSeq`. Compare `selectedWorkspace?.id` directly even though ordinary
workspace selection also increments the sequence; the direct check protects
against state reconciliation/replacement paths, and the test deliberately
exercises that independent guard. Implement `applySessionOrderEntries()` with a map keyed by
`JSON.stringify([cwd, id])`; leave non-submitted sessions and object identities
unchanged. `captureSessionOrderEntries()` records a required
`manualOrder: number | undefined` field for each matching identity.
`restoreSessionOrderEntries()` sets the saved number or removes the property via
destructuring when the saved value is `undefined`, preserving every other field
from the current session object.

When client-side `detachParent()` clones a detached session, also delete
`manualOrder` before `replaceSession(detached)`.

- [ ] **Step 5: Run client orchestration verification**

Run:

```bash
npm test -- --run src/client/src/api/parsers.test.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/sessionController.reorder.test.ts src/client/src/controllers/sessionController.refresh.test.ts
npm run typecheck
npx eslint src/client/src/api.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.reorder.test.ts
npm run knip
```

Expected: all commands PASS. The API path remains nested-deployment-safe, only
one request is active, and failed/late responses cannot overwrite a new scope.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/api.ts src/client/src/api/parsers.ts src/client/src/api/parsers.test.ts src/client/src/api/clients.ts src/client/src/api/clients.test.ts src/client/src/api/federatedRouteContract.test.ts src/client/src/controllers/sessionController.ts src/client/src/controllers/sessionController.reorder.test.ts
git commit -m "feat(sessions): orchestrate optimistic reorder"
```

## Task 5: Implement selected-row mouse and touch drag interaction

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/sessionReorder.ts`
- Create: `src/client/src/sessionReorder.test.ts`
- Modify: `src/client/src/components/SessionList.ts:1-125,125-181,357-423,620-734`
- Create: `src/client/src/components/SessionList.reorder.test.ts`
- Modify: `src/client/src/components/SessionList.crossWorkspace.test.ts:70-100`
- Modify: `src/client/src/components/SessionBrowserDialog.test.ts`

**Interfaces:**

- Consumes: `SessionReorderRequest`, `SessionReorderScope`, `SessionInfo`,
  `SESSION_REORDER_LIMIT`, `SessionRow`, `sessionRowsForCurrentTree()`, and controller callback
  `(session: SessionInfo, input: SessionReorderRequest) => Promise<void>`.
- Produces constants `SESSION_REORDER_DRAG_THRESHOLD_PX = 6`,
  `SESSION_REORDER_EDGE_ZONE_PX = 32`, and
  `SESSION_REORDER_MAX_SCROLL_PX = 12`.
- Produces `eligibleSessionReorderGroup(rows, selected,
  currentWorkspacePath): SessionInfo[]`, `sessionReorderRequest(selected, group,
  catalogCwds): SessionReorderRequest`, `moveSessionInGroup(group, selectedId,
  insertionIndex): SessionInfo[]`, `sessionReorderInsertionIndex(pointerY,
  peerRects): number`, `sessionReorderThresholdReached(origin, current):
  boolean`, `sessionReorderSubtreePaths(rows, sessionPath): string[]`, and
  `sessionReorderEdgeScrollDelta(pointerY, top, bottom): number`.
- Produces `SessionList.canReorder: boolean` and `SessionList.onReorder?:
  (session: SessionInfo, input: SessionReorderRequest) => void | Promise<void>`.
- Keeps all pointer capture, document listeners, edge-scroll animation, drag
  classes, and pending state private to `SessionList`.

- [ ] **Step 1: Write failing pure drag-domain tests**

Create `sessionReorder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import type { SessionRow } from "./sessionTreeRows";
import {
  eligibleSessionReorderGroup,
  moveSessionInGroup,
  sessionReorderEdgeScrollDelta,
  sessionReorderInsertionIndex,
  sessionReorderRequest,
  sessionReorderSubtreePaths,
  sessionReorderThresholdReached,
} from "./sessionReorder";

function session(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: "",
    ...patch,
  };
}

function row(value: SessionInfo, depth: number, external = false, hasMissingParent = false): SessionRow {
  return { session: value, depth, external, hasMissingParent, hasChildren: false, folded: false };
}

describe("session sidebar reorder domain", () => {
  it("finds only persisted current peers in the exact root/pin group", () => {
    const selected = session("selected", "/repo");
    const rows = [
      row(selected, 0),
      row(session("peer", "/repo"), 0),
      row(session("other-workspace", "/feature"), 0, true),
      row(session("pinned", "/repo", { pinned: true }), 0),
      row(session("transient", "/repo", { persisted: false }), 0),
      row(session("archived", "/repo", { archived: true }), 0),
    ];
    expect(eligibleSessionReorderGroup(rows, selected, "/repo").map(({ id }) => id))
      .toEqual(["selected", "peer"]);
  });

  it("keeps a promoted missing-parent child read-only until its parent is projected", () => {
    const orphan = session("orphan", "/repo", {
      parentSessionPath: "/sessions/missing-parent.jsonl",
    });
    expect(eligibleSessionReorderGroup([row(orphan, 0, false, true)], orphan, "/repo"))
      .toEqual([]);
  });

  it("allows cross-workspace child peers only under the exact same parent", () => {
    const selected = session("selected", "/repo", { parentSessionPath: "/sessions/parent.jsonl" });
    const rows = [
      row(selected, 1),
      row(session("peer", "/feature", { parentSessionPath: selected.parentSessionPath }), 1, true),
      row(session("other-parent", "/repo", { parentSessionPath: "/sessions/other.jsonl" }), 1),
    ];
    expect(eligibleSessionReorderGroup(rows, selected, "/repo").map(({ id }) => id))
      .toEqual(["selected", "peer"]);
    expect(sessionReorderRequest(selected, [selected, rows[1]!.session], ["/repo", "/feature"]))
      .toEqual({
        cwd: "/repo",
        scope: { kind: "children", parentSessionPath: "/sessions/parent.jsonl" },
        pinned: false,
        catalogCwds: ["/repo", "/feature"],
        orderedSessions: [
          { id: "selected", cwd: "/repo" },
          { id: "peer", cwd: "/feature" },
        ],
      });
  });

  it("moves against the remaining peer slots and detects no-op positions", () => {
    const group = [session("first"), session("selected"), session("last")];
    expect(moveSessionInGroup(group, "selected", 0).map(({ id }) => id))
      .toEqual(["selected", "first", "last"]);
    expect(moveSessionInGroup(group, "selected", 1).map(({ id }) => id))
      .toEqual(["first", "selected", "last"]);
    expect(moveSessionInGroup(group, "selected", 2).map(({ id }) => id))
      .toEqual(["first", "last", "selected"]);
  });

  it("refuses groups or project catalogs beyond the shared protocol limit", () => {
    const selected = session("selected");
    const oversized = Array.from({ length: 1_001 }, (_, index) => session(`s-${index}`));
    expect(() => sessionReorderRequest(selected, oversized, ["/repo"]))
      .toThrow("Session reorder exceeds the 1000-entry limit");
    expect(() => sessionReorderRequest(
      selected,
      [selected, session("peer")],
      Array.from({ length: 1_001 }, (_, index) => `/repo-${index}`),
    )).toThrow("Session reorder exceeds the 1000-entry limit");
  });

  it("returns one sibling's complete depth-first subtree without crossing its next sibling", () => {
    const parent = session("parent");
    const first = session("first", "/repo", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", "/repo", { parentSessionPath: first.path });
    const second = session("second", "/repo", { parentSessionPath: parent.path });
    const rows = [row(parent, 0), row(first, 1), row(grandchild, 2), row(second, 1)];
    expect(sessionReorderSubtreePaths(rows, first.path)).toEqual([first.path, grandchild.path]);
    expect(sessionReorderSubtreePaths(rows, second.path)).toEqual([second.path]);
  });

  it("uses exact threshold, midpoint slots, and bounded proportional edge scrolling", () => {
    expect(sessionReorderThresholdReached({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(sessionReorderThresholdReached({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
    expect(sessionReorderInsertionIndex(49, [
      { sessionPath: "/sessions/a.jsonl", top: 0, bottom: 40 },
      { sessionPath: "/sessions/b.jsonl", top: 60, bottom: 100 },
    ])).toBe(1);
    expect(sessionReorderInsertionIndex(100, [
      { sessionPath: "/sessions/a.jsonl", top: 0, bottom: 40 },
      { sessionPath: "/sessions/b.jsonl", top: 60, bottom: 100 },
    ])).toBe(2);
    expect(sessionReorderEdgeScrollDelta(0, 0, 200)).toBe(-12);
    expect(sessionReorderEdgeScrollDelta(16, 0, 200)).toBe(-6);
    expect(sessionReorderEdgeScrollDelta(100, 0, 200)).toBe(0);
    expect(sessionReorderEdgeScrollDelta(200, 0, 200)).toBe(12);
  });
});
```

- [ ] **Step 2: Write failing real-DOM component interaction tests**

Create `SessionList.reorder.test.ts` with `// @vitest-environment jsdom`. Mount
the real custom element and stub only missing layout/browser APIs:

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionReorderRequest } from "../api";
import { SessionList } from "./SessionList";

let nextFrameId: number;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  nextFrameId = 0;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  delete HTMLElement.prototype.scrollIntoView;
  delete HTMLElement.prototype.setPointerCapture;
  delete HTMLElement.prototype.hasPointerCapture;
  delete HTMLElement.prototype.releasePointerCapture;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runNextFrame(): void {
  const first = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (first === undefined) throw new Error("Expected a queued animation frame");
  frames.delete(first[0]);
  first[1](0);
}

function pointer(type: string, input: { pointerId: number; clientX: number; clientY: number; pointerType?: string }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperties(event, {
    pointerId: { value: input.pointerId },
    clientX: { value: input.clientX },
    clientY: { value: input.clientY },
    pointerType: { value: input.pointerType ?? "mouse" },
    button: { value: 0 },
    isPrimary: { value: true },
  });
  return event;
}

function sessionFixture(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return { id, cwd, path: `/sessions/${id}.jsonl`, persisted: true, created: "now", modified: "now", messageCount: 0, firstMessage: id, ...patch };
}

async function mountList(input: {
  sessions: SessionInfo[];
  projectSessions?: SessionInfo[];
  selected: SessionInfo;
  workspaces?: SessionList["workspaces"];
}): Promise<SessionList> {
  const list = new SessionList();
  Object.assign(list, {
    sessions: input.sessions,
    projectSessions: input.projectSessions ?? input.sessions,
    selected: input.selected,
    currentWorkspacePath: "/repo",
    canReorder: true,
    authoritativeSessionPersistence: true,
    workspaces: input.workspaces ?? [{ id: "main", projectId: "project", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false }],
  });
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function elementByData(root: ParentNode, name: string, value: string): HTMLElement {
  const element = [...root.querySelectorAll<HTMLElement>(`[${name}]`)]
    .find((candidate) => candidate.getAttribute(name) === value);
  if (element === undefined) throw new Error(`Missing ${name}=${value}`);
  return element;
}

function setRect(element: Element, left: number, top: number, right: number, bottom: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) }),
  });
}

it("drags a complete root family after its root peer", async () => {
  const parent = sessionFixture("parent");
  const child = sessionFixture("child", "/repo", { parentSessionPath: parent.path });
  const peer = sessionFixture("peer");
  const list = await mountList({ sessions: [parent, child, peer], selected: parent });
  const submitted: { session: SessionInfo; input: SessionReorderRequest }[] = [];
  let settleSubmission = (): void => undefined;
  const submission = new Promise<void>((resolve) => { settleSubmission = resolve; });
  list.onReorder = (session, input) => {
    submitted.push({ session, input });
    return submission;
  };
  const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
  const grip = list.renderRoot.querySelector<HTMLElement>(".session-reorder-grip");
  if (body === null || grip === null) throw new Error("Missing reorder DOM");
  const parentSubject = elementByData(list.renderRoot, "data-session-reorder-path", parent.path);
  const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
  setRect(body, 0, 0, 340, 200);
  setRect(parentSubject, 0, 0, 340, 50);
  setRect(peerSubject, 0, 60, 340, 100);

  grip.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
  document.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 10, clientY: 90 }));
  expect(parentSubject.classList.contains("session-reorder-dragging")).toBe(true);
  expect(peerSubject.classList.contains("session-drop-after")).toBe(true);
  document.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 90 }));
  await vi.waitFor(() => { expect(submitted).toHaveLength(1); });

  expect(submitted[0]?.session).toBe(parent);
  expect(submitted[0]?.input.orderedSessions).toEqual([
    { id: "peer", cwd: "/repo" },
    { id: "parent", cwd: "/repo" },
  ]);
  expect(submitted[0]?.input.orderedSessions.some(({ id }) => id === child.id)).toBe(false);
  expect(parentSubject.classList.contains("session-reorder-dragging")).toBe(false);
  expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1);
  await list.updateComplete;
  expect(list.renderRoot.querySelector(".session-reorder-grip")).toBeNull();
  settleSubmission();
  await vi.waitFor(() => {
    expect(list.renderRoot.querySelector(".session-reorder-grip")).not.toBeNull();
  });
});

it("uses the same pointer flow for cross-workspace child peers on touch", async () => {
  const parent = sessionFixture("parent");
  const selected = sessionFixture("selected", "/repo", { parentSessionPath: parent.path });
  const peer = sessionFixture("peer", "/feature", { parentSessionPath: parent.path });
  const list = await mountList({
    sessions: [parent, selected],
    projectSessions: [parent, selected, peer],
    selected,
    workspaces: [
      { id: "main", projectId: "project", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false },
      { id: "feature", projectId: "project", path: "/feature", label: "feature", isMain: false, isGitRepo: true, isGitWorktree: true },
    ],
  });
  const submitted: SessionReorderRequest[] = [];
  list.onReorder = async (_session, input) => { submitted.push(input); };
  const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
  const grip = list.renderRoot.querySelector<HTMLElement>(".session-reorder-grip");
  if (body === null || grip === null) throw new Error("Missing reorder DOM");
  const selectedSubject = elementByData(list.renderRoot, "data-session-reorder-path", selected.path);
  const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
  setRect(body, 0, 0, 340, 200);
  setRect(selectedSubject, 0, 0, 340, 40);
  setRect(peerSubject, 0, 50, 340, 90);

  grip.dispatchEvent(pointer("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 10 }));
  document.dispatchEvent(pointer("pointermove", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 80 }));
  document.dispatchEvent(pointer("pointerup", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 80 }));
  await vi.waitFor(() => { expect(submitted).toHaveLength(1); });

  expect(submitted[0]).toMatchObject({
    scope: { kind: "children", parentSessionPath: parent.path },
    catalogCwds: ["/repo", "/feature"],
    orderedSessions: [
      { id: "peer", cwd: "/feature" },
      { id: "selected", cwd: "/repo" },
    ],
  });
});
```

Add the remaining tests with the same rendered fixture helpers:

1. A selected persisted local row with one peer and `canReorder = true` renders
   `[title="Drag to reorder selected session"]`; unselected, archived,
   transient, external, active-search, bulk-selection, rename, and
   `canReorder = false` cases do not. The grip is a non-focusable `span`, has no
   button role, ignores pen/non-primary pointers, and stays absent for a group
   or unique project catalog over `SESSION_REORDER_LIMIT`. A local
   `hasMissingParent` row also has no grip because its child-scope order is not
   projected while it is promoted to a visual root.
2. Movement of 5 pixels, a same-slot drop, pointercancel, Escape, a property
   change, pointerup outside the `.list-body` rectangle, and disconnect each
   submit nothing and release capture/cancel any frame.
3. An edge movement queues one frame, `runNextFrame()` changes `scrollTop` by no
   more than 12px and recomputes the marker, and pointercancel empties `frames`.
4. Static style assertions require a 24px slot/grip, `touch-action: none`, a 2px
   insertion indicator, and selected-row surface styling for the slot.

Use actual DOM selectors
`[data-session-reorder-path]`, `[data-session-row-path]`,
`.session-reorder-grip`,
`.session-family-frame`, and `.list-body`. Define `getBoundingClientRect()` on
the exact peer subject nodes; do not use TemplateResult handler extraction for
this pointer flow.

At this same red-test stage, extend `SessionList.crossWorkspace.test.ts` to
prove an external selected row never has a grip while a local child may still
include the external child as a drop peer. Extend
`SessionBrowserDialog.test.ts` with sessions carrying `manualOrder` and a
selected session; mount/render it and assert it contains no
`.session-reorder-grip` or reorder callback property while its projected row
order still reflects `manualOrder`.

- [ ] **Step 3: Run the pure and component tests and confirm red failures**

Run:

```bash
npm test -- --run src/client/src/sessionReorder.test.ts src/client/src/components/SessionList.reorder.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionList.crossWorkspace.test.ts src/client/src/components/SessionBrowserDialog.test.ts
```

Expected: FAIL because the helper module, grip, pointer handlers, data markers,
styles, and callback do not exist.

- [ ] **Step 4: Implement the pure reorder helper module**

Implement the exact exported constants and signatures from the Interfaces block.
Use these rules:

```ts
export interface SessionReorderPeerRect {
  sessionPath: string;
  top: number;
  bottom: number;
}

export function sessionReorderThresholdReached(
  origin: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= SESSION_REORDER_DRAG_THRESHOLD_PX;
}

export function sessionReorderInsertionIndex(
  pointerY: number,
  peerRects: readonly SessionReorderPeerRect[],
): number {
  const index = peerRects.findIndex((rect) => pointerY < rect.top + (rect.bottom - rect.top) / 2);
  return index === -1 ? peerRects.length : index;
}

export function sessionReorderEdgeScrollDelta(pointerY: number, top: number, bottom: number): number {
  if (pointerY < top + SESSION_REORDER_EDGE_ZONE_PX) {
    const proximity = Math.min(1, (top + SESSION_REORDER_EDGE_ZONE_PX - pointerY) / SESSION_REORDER_EDGE_ZONE_PX);
    return -Math.ceil(proximity * SESSION_REORDER_MAX_SCROLL_PX);
  }
  if (pointerY > bottom - SESSION_REORDER_EDGE_ZONE_PX) {
    const proximity = Math.min(1, (pointerY - (bottom - SESSION_REORDER_EDGE_ZONE_PX)) / SESSION_REORDER_EDGE_ZONE_PX);
    return Math.ceil(proximity * SESSION_REORDER_MAX_SCROLL_PX);
  }
  return 0;
}
```

`eligibleSessionReorderGroup()` must find the row whose path, CWD, and id match
the selected session, reject an external or `hasMissingParent` selected row, require
`persisted === true` and unarchived state, match pin state, then select either
depth-zero roots in the same CWD or exact-parent children. Peers may be external
child context rows. Preserve row order.

`sessionReorderSubtreePaths()` finds the target row in depth-first projected
rows and returns its path plus every following row with greater depth, stopping
before the next equal-or-shallower row. Return `[]` when the path is absent.
This keeps child descendants attached when peer midpoint rectangles are built.

`moveSessionInGroup()` removes the selected item first, clamps insertion index to
the remaining array's `0..length` range, and reinserts it. Build request refs
from only `id` and `cwd`, de-duplicate catalog CWDs without changing first-seen
order, and derive root/children scope from the selected session. Reject request
construction when either unique catalog CWDs or group members exceed
`SESSION_REORDER_LIMIT`; `canDrag` applies the same check so an oversized group
never exposes a grip that can only receive `400`.

Import `SESSION_REORDER_LIMIT` directly from `../../shared/apiTypes`; do not
stage a client API re-export solely for this helper.

- [ ] **Step 5: Implement contained pointer state and grip rendering**

Add `canReorder`, `onReorder`, and private `reorderPending` state to
`SessionList`. Add a private non-reactive pending/active drag record containing:

```ts
interface SessionPointerDrag {
  pointerId: number;
  pointerType: string;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  handle: HTMLElement;
  selected: SessionInfo;
  group: SessionInfo[];
  active: boolean;
  insertionIndex?: number;
}
```

Register document `pointermove`, `pointerup`, `pointercancel`, and `keydown`
listeners beside the existing click listener in `connectedCallback()`. Remove
all of them and call one idempotent `cancelSessionReorder()` before
`super.disconnectedCallback()`.

In `render()`, derive the eligible group exactly once from
`unfoldedCurrentRows`, `selected`, and `currentWorkspacePath`, but only when
`!searchOpen && !searchActive`; otherwise use `[]`. Pass that group and the currently rendered
`currentRows` into `renderSession()`; do not derive peers independently per row.

Render `data-session-row-path=${session.path}` on each current `.action-row`.
Render `data-session-reorder-path=${session.path}` on exactly one primary subject:
the `.session-family-frame` for a root with rendered descendants and the
`.action-row` otherwise. Do not duplicate the root's reorder path on its nested
action row. Archived/search rows may retain the stable empty slot but receive no
reorder subject marker.
Render one reserved slot for every local row beside the existing action menu:

```ts
<div class="session-row-controls">
  <span class="session-reorder-slot">
    ${canDrag ? html`
      <span
        class="session-reorder-grip"
        title="Drag to reorder selected session"
        data-session-reorder-handle=${session.path}
        @pointerdown=${(event: PointerEvent) => { this.beginSessionReorder(event, session, reorderGroup); }}
      >${svg`<svg class="session-reorder-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1"></circle><circle cx="15" cy="6" r="1"></circle><circle cx="9" cy="12" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="18" r="1"></circle><circle cx="15" cy="18" r="1"></circle></svg>`}</span>
    ` : null}
  </span>
  <div class="action-menu">...</div>
</div>
```

Keep the existing menu body unchanged inside the wrapper. `canDrag` requires
the exact Handle Eligibility rules from the approved spec, including
`!reorderPending`, and group length > 1.
It also rejects non-primary pointers, non-left-button mouse input, and pointer
types other than `mouse` and `touch` without changing selection.

On pointerdown, stop propagation/default behavior, record pending state, and
close the action menu. On document movement:

1. ignore another pointer id;
2. activate only after the pure 6px threshold;
3. capture the pointer on the grip;
4. add `.session-reorder-dragging` to the dragged subject;
5. collect remaining peer subject rectangles in group order: a root uses its
   family frame; a child uses the union from its own row's top to the last
   currently rendered row returned by `sessionReorderSubtreePaths()`;
6. compute the insertion index and apply exactly one `.session-drop-before` or
   `.session-drop-after` class to the first/last boundary element;
7. update the latest `clientX`/`clientY` and schedule at most one edge-scroll
   frame.

The frame adds the pure bounded delta to `.list-body.scrollTop`, recomputes the
candidate against shifted rectangles, and reschedules only while the delta is
nonzero **and** the previous frame actually changed `scrollTop`; stop at the
container's scroll boundaries instead of spinning. On pointerup, require the
latest pointer coordinates to remain inside the `.list-body` rectangle,
recompute the candidate once from current rectangles, and require that
candidate. For a valid changed drop,
copy state, clean all effects first, set `reorderPending`, build the moved
group/request from unique `workspaces[].path`, group-member CWDs, and the
selected CWD, await `onReorder`, swallow callback rejection because the
controller owns the application error surface, and clear pending in `finally`.
Escape, pointercancel,
same-slot drop, missing callback, outside-list release, and invalid target call
cleanup without a request.

Call cleanup from `updated()` when `selected`, `sessions`, `projectSessions`,
`currentWorkspacePath`, `workspaces`, `collapsed`, `canReorder`, `searchOpen`,
`searchQuery`, `selectionScopes`, or `renamingSessionId` changes during a
pending/active drag. Also cancel synchronously when toggling search, entering
bulk selection, or starting rename.

- [ ] **Step 6: Add stable visual states and finish DOM assertions**

Add component-local CSS:

```css
.session-row-controls { display: flex; align-items: stretch; }
.session-reorder-slot { box-sizing: border-box; flex: 0 0 24px; width: 24px; display: grid; place-items: center; border-block: 1px solid var(--pi-border); background: var(--pi-surface); }
.session-reorder-grip { box-sizing: border-box; display: grid; place-items: center; width: 24px; height: 24px; align-self: center; color: var(--pi-muted); cursor: grab; touch-action: none; user-select: none; }
.session-reorder-grip:active { cursor: grabbing; }
.session-reorder-icon { width: 16px; height: 16px; fill: currentColor; }
.session-family-frame, .action-row { position: relative; }
.action-row.selected .session-reorder-slot { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
.session-reorder-dragging { opacity: .45; }
.session-drop-before::before, .session-drop-after::after { content: ""; position: absolute; right: 0; left: 0; z-index: 4; height: 2px; background: var(--pi-accent); pointer-events: none; }
.session-drop-before::before { top: -4px; }
.session-drop-after::after { bottom: -4px; }
```

Adjust selected styling so the reserved slot and menu toggle share the selected
surface. Keep the slot at 24px even when empty, and ensure the row's trailing
controls retain stable width. Make the style, cross-workspace, and expanded
browser assertions written in Step 2 pass without introducing drag state into
`SessionBrowserDialog`.

- [ ] **Step 7: Run pointer feature verification**

Run:

```bash
npm test -- --run src/client/src/sessionReorder.test.ts src/client/src/components/SessionList.reorder.test.ts src/client/src/components/SessionList.test.ts src/client/src/components/SessionList.crossWorkspace.test.ts src/client/src/components/SessionBrowserDialog.test.ts src/client/src/sessionTreeRows.order.test.ts
npm run typecheck
npx eslint src/client/src/sessionReorder.ts src/client/src/sessionReorder.test.ts src/client/src/components/SessionList.ts src/client/src/components/SessionList.reorder.test.ts src/client/src/components/SessionList.crossWorkspace.test.ts src/client/src/components/SessionBrowserDialog.test.ts
npm run knip
```

Expected: all commands PASS. Real DOM events prove capture, cleanup, root-family
and child behavior; pure tests prove geometry without relying on jsdom layout.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/sessionReorder.ts src/client/src/sessionReorder.test.ts src/client/src/components/SessionList.ts src/client/src/components/SessionList.reorder.test.ts src/client/src/components/SessionList.crossWorkspace.test.ts src/client/src/components/SessionBrowserDialog.test.ts
git commit -m "feat(sessions): drag selected sidebar sessions"
```

## Task 6: Wire capability, recovery, release notes, and end-to-end verification

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/appShell/AppNavigationPanel.ts:24-115,184-225`
- Modify: `src/client/src/components/appShell/AppNavigationPanel.test.ts:60-125`
- Modify: `src/client/src/components/PiWebUiApp.ts:199-235,1490-1530,1886-1970`
- Create: `src/client/src/components/PiWebUiApp.sessionReorder.test.ts`
- Create: `.changeset/persistent-session-order.md`
- Verify only, then remove: `src/client/reorder-probe.html`

**Interfaces:**

- Consumes: capability `PI_WEBUI_CAPABILITIES.sessionsReorder`,
  `SessionController.reorderSession(session, input): Promise<void>`, optional
  `refreshProjectSessionCatalog(): void | Promise<void>`, and
  `SessionList.canReorder`/`SessionList.onReorder`.
- Produces: `AppNavigationPanel.canReorderSessions: boolean` and
  `onReorderSession?: (session: SessionInfo, input: SessionReorderRequest) =>
  void | Promise<void>` forwarded unchanged to `SessionList`.
- Produces: `PiWebUiApp.canReorderSessions(): boolean`, true only for an `ok`
  selected runtime advertising `sessions.reorder`.
- Produces: project-catalog recovery wiring
  `refreshProjectSessionCatalog: () => this.projectCatalog.refresh()`.
- Produces: patch Changeset text `Add persistent drag ordering for selected
  sessions in the Sessions sidebar.`

- [ ] **Step 1: Write failing app-shell wiring tests**

In `AppNavigationPanel.test.ts`, import `SessionInfo` and
`SessionReorderRequest`, then add a narrow component-boundary test:

```ts
it("forwards session reorder capability and requests to SessionList", async () => {
  const panel = new AppNavigationPanel();
  const pending = Promise.resolve();
  const onReorderSession = vi.fn(() => pending);
  panel.canReorderSessions = true;
  panel.onReorderSession = onReorderSession;
  const rendered = panel.render();

  expect(templateValueAfterMarker(rendered, ".canReorder=")).toBe(true);
  const callback = templateValueAfterMarker(rendered, ".onReorder=");
  if (typeof callback !== "function") throw new Error("Expected SessionList reorder callback");
  const selected = sessionFixture("selected");
  const request = reorderRequestFixture(selected);
  expect(callback(selected, request)).toBe(pending);
  await pending;

  expect(onReorderSession).toHaveBeenCalledWith(selected, request);
});

function sessionFixture(id: string): SessionInfo {
  return {
    id,
    cwd: "/repo",
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: id,
  };
}

function reorderRequestFixture(selected: SessionInfo): SessionReorderRequest {
  return {
    cwd: selected.cwd,
    scope: { kind: "root", cwd: selected.cwd },
    pinned: false,
    catalogCwds: [selected.cwd],
    orderedSessions: [{ id: selected.id, cwd: selected.cwd }],
  };
}
```

Use file-local typed fixtures with full `SessionInfo` and
`SessionReorderRequest` fields; do not weaken the callback to `any`.

Create `PiWebUiApp.sessionReorder.test.ts` following the existing
`renderNavigationPanel()` reflection pattern and the typed
`stateWithRuntime()`/`runtimeWithCapabilities()` fixtures in
`PiWebUiApp.clearQueue.test.ts`. Use this test body:

```ts
describe("PiWebUiApp session reorder wiring", () => {
  it("gates reordering on the selected runtime capability", () => {
    const app = createApp();
    const supported = stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReorder,
    ]));
    setAppState(app, supported);
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(true);

    setAppState(app, stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReload,
    ])));
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(false);
    setAppState(app, stateWithRuntime(undefined));
    expect(templateValueAfterMarker(
      renderNavigationPanel(app),
      ".canReorderSessions=",
    )).toBe(false);
  });

  it("forwards exact reorder requests to SessionController", async () => {
    const app = createApp();
    const state = stateWithRuntime(runtimeWithCapabilities([
      PI_WEBUI_CAPABILITIES.sessionsReorder,
    ]));
    setAppState(app, state);
    const selected = state.selectedSession;
    if (selected === undefined) throw new Error("Expected selected session fixture");
    const request = reorderRequestFixture(selected);
    const reorderSession = vi.spyOn(appSessionController(app), "reorderSession")
      .mockResolvedValue(undefined);
    const value = templateValueAfterMarker(
      renderNavigationPanel(app),
      ".onReorderSession=",
    );
    if (!isReorderCallback(value)) throw new Error("Expected session reorder callback");

    const returned = value(selected, request);
    expect(returned).toBe(reorderSession.mock.results[0]?.value);
    await returned;

    expect(reorderSession).toHaveBeenCalledExactlyOnceWith(selected, request);
  });

  it("injects project-catalog refresh as the controller recovery boundary", async () => {
    const app = createApp();
    const projectCatalog: unknown = Reflect.get(app, "projectCatalog");
    if (!(projectCatalog instanceof ProjectCatalogController)) {
      throw new Error("PiWebUiApp ProjectCatalogController was unavailable");
    }
    const refresh = vi.spyOn(projectCatalog, "refresh").mockResolvedValue(undefined);
    const recovery: unknown = Reflect.get(
      appSessionController(app),
      "refreshProjectSessionCatalog",
    );
    if (typeof recovery !== "function") throw new Error("Expected project catalog recovery dependency");

    await recovery();

    expect(refresh).toHaveBeenCalledOnce();
  });
});
```

Import `ProjectCatalogController`, `SessionController`, the shared capability,
and template inspection helper explicitly. Define
`isReorderCallback(value): value is (session: SessionInfo, input:
SessionReorderRequest) => void | Promise<void>` and reuse the complete typed
request fixture from the panel test rather than casting callbacks.

- [ ] **Step 2: Run wiring tests and confirm red failures**

Run:

```bash
npm test -- --run src/client/src/components/appShell/AppNavigationPanel.test.ts src/client/src/components/PiWebUiApp.sessionReorder.test.ts
```

Expected: FAIL because app-shell capability properties, callback forwarding,
runtime gating, and recovery injection are not wired.

- [ ] **Step 3: Implement thin app-shell wiring**

Add `canReorderSessions` and `onReorderSession` properties to
`AppNavigationPanel`; pass them as `.canReorder` and `.onReorder` without local
state or transformation.

In `PiWebUiApp`, add:

```ts
private canReorderSessions(): boolean {
  const runtime = this.selectedMachineRuntime();
  return runtime?.ok === true
    && supportsPiWebUiCapability(runtime, PI_WEBUI_CAPABILITIES.sessionsReorder);
}
```

Pass the recovery dependency when constructing `SessionController`:

```ts
refreshProjectSessionCatalog: () => this.projectCatalog.refresh(),
```

The closure is safe even though `projectCatalog` is initialized later because
it is invoked only after construction and user interaction. In
`renderNavigationPanel()`, pass:

```ts
.canReorderSessions=${this.canReorderSessions()}
.onReorderSession=${(session: SessionInfo, input: SessionReorderRequest) =>
  this.sessions.reorderSession(session, input)}
```

Import `SessionReorderRequest` as a type. Do not add order state to
`PiWebUiApp` or `AppNavigationPanel`.

- [ ] **Step 4: Add the patch Changeset**

Create `.changeset/persistent-session-order.md` exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Add persistent drag ordering for selected sessions in the Sessions sidebar.
```

Do not modify `CHANGELOG.md`, README, config docs, or user manuals.

- [ ] **Step 5: Run focused integration and whole-project verification**

Run:

```bash
npm test -- --run src/client/src/components/appShell/AppNavigationPanel.test.ts src/client/src/components/PiWebUiApp.sessionReorder.test.ts src/client/src/components/SessionList.reorder.test.ts src/client/src/controllers/sessionController.reorder.test.ts src/client/src/api/clients.test.ts src/server/sessions/piSessionService.order.test.ts src/server/sessions/sessionRoutes.test.ts src/shared/capabilities.test.ts
npm run typecheck
npm run lint
npm run knip
npm run verify
git diff --check
```

Expected: all commands PASS with zero test failures, type errors, lint errors,
or new Knip findings. `git diff --check` prints nothing.

- [ ] **Step 6: Run Chromium layout and interaction probes**

Read and follow the project procedure at
`/home/henry/.pi/agent/projects-memory/pi-webui/skills/probe-narrow-lit-layout-with-chromium-cdp/SKILL.md`.
Create a temporary `src/client/reorder-probe.html` with `apply_patch`; it must
import `/src/components/SessionList.ts`, copy the root CSS variables from
`src/client/index.html`, mount a 340px-wide `session-list`, and assign:

```js
const parent = { id: "parent", path: "/sessions/parent.jsonl", cwd: "/repo", persisted: true, created: "now", modified: "now", messageCount: 2, firstMessage: "Parent" };
const child = { id: "child", path: "/sessions/child.jsonl", cwd: "/repo", persisted: true, created: "now", modified: "now", messageCount: 1, firstMessage: "Child", parentSessionPath: parent.path };
const peer = { id: "peer", path: "/sessions/peer.jsonl", cwd: "/repo", persisted: true, created: "now", modified: "now", messageCount: 3, firstMessage: "A deliberately long peer session name that must not overlap controls" };
const extraChildren = Array.from({ length: 18 }, (_, index) => ({ id: `peer-child-${index}`, path: `/sessions/peer-child-${index}.jsonl`, cwd: "/repo", persisted: true, created: "now", modified: "now", messageCount: index, firstMessage: `Peer child ${index}`, parentSessionPath: peer.path }));
Object.assign(list, {
  sessions: [parent, child, peer, ...extraChildren],
  projectSessions: [parent, child, peer, ...extraChildren],
  currentWorkspacePath: "/repo",
  workspaces: [{ id: "repo", projectId: "project", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false }],
  selected: parent,
  canReorder: true,
  authoritativeSessionPersistence: true,
  onReorder: (session, request) => { window.lastReorder = { session, request }; },
});
```

Start an isolated Vite process from this worktree:

```bash
PI_WEBUI_PORT=8818 npm run dev:client -- --host 127.0.0.1 --port 8819 --strictPort
```

Using Chromium CDP, verify at exact `340x800` and `760x900` viewports:

- the grip rectangle is exactly `24x24`;
- the grip and `.action-menu-toggle` rectangles do not intersect;
- the longest label's rectangle ends before the grip slot;
- the first family frame becomes the drag subject, not only its root row;
- a peer family's `getBoundingClientRect()` is identical immediately before
  pointerdown and during pointermove, proving the list does not reorder live;
- mouse movement below 6px submits nothing, while a valid root move sets
  `window.lastReorder.request.orderedSessions` to `[peer, parent]`;
- touch dispatch produces the same request;
- moving an active drag into each edge zone changes `.list-body.scrollTop` by at
  most 12px per animation frame and stops at the scroll boundary;
- no non-selected row, child row, or Archived/search projection contains a
  grip; the expanded Sessions browser exclusion is covered by Task 5's mounted
  `SessionBrowserDialog` regression test;
- screenshots contain nonblank pixels and no incoherent overlap.

Save screenshots under `/tmp`, not the repository. Stop Vite, remove
`src/client/reorder-probe.html` with `apply_patch`, and verify
`git status --short` contains no probe artifact. If port 8819 is occupied, pick
the next free pair and use that exact pair for both Vite and CDP.

- [ ] **Step 7: Commit integration and release metadata**

```bash
git add src/client/src/components/appShell/AppNavigationPanel.ts src/client/src/components/appShell/AppNavigationPanel.test.ts src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionReorder.test.ts .changeset/persistent-session-order.md
git commit -m "feat(sessions): enable persistent sidebar ordering"
```

After commit, run:

```bash
git status --short
git log -6 --oneline
```

Expected: the worktree is clean and the six feature commits appear in task
order. Record in the implementation handoff that
`pi-webui-sessiond.service` must be manually restarted before the installed
split-service environment advertises `sessions.reorder`.
