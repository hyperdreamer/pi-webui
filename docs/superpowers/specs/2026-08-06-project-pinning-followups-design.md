# Project pinning follow-up fixes

**Date:** 2026-08-06
**Status:** Approved design
**Follows:** `2026-08-06-project-pinning-design.md`

## Problem

An independent final review of the `project-pinning` branch found two defects worth fixing. Both are pre-existing weaknesses in `ProjectStore` and the project route family that the pinning feature makes materially easier to hit, because pinning turns `projects.json` writes into a frequent, user-triggered operation instead of a rare one.

A third finding (pin controls rendered on archived session rows) was reviewed and **accepted as designed**; it is out of scope here.

### F-2: `projects.json` writes are not atomic

`ProjectStore.write` is a bare `writeFile`. A crash, full disk, or interrupted write can truncate the file. `parseProjectFile` then throws for the whole document, so **every** project becomes unreadable rather than just losing a pin flag.

Verified by probe: after simulating a torn write, `store.list()` rejects.

`SessionMetadataStore` — the store project pinning was modelled on — already writes to a temp file and `rename`s it onto the target. `ProjectStore` never adopted that.

### F-3: project routes report every failure as 404

Four handlers in `app.ts` catch all errors and respond `404`:

| Line | Route |
| --- | --- |
| :82 | `DELETE ${prefix}/projects/:projectId` |
| :90 | `POST ${prefix}/projects/:projectId/pin` |
| :98 | `POST ${prefix}/projects/:projectId/unpin` |
| :115 | `GET ${prefix}/projects/:projectId/workspaces` |

A store I/O failure, or a git/filesystem failure while listing workspaces, is therefore reported to the user as "Project not found". The message actively misdirects debugging.

## Decisions

### F-2: adopt the session store's durable write

`ProjectStore.write` writes `.<basename>.<pid>.<timestamp>.<uuid>.tmp` in the target directory, then `rename`s it onto the real path, unlinking the temp file if either step fails. `rename` is atomic within a filesystem, so a reader observes either the previous file or the complete new one.

This copies `SessionMetadataStore.write` deliberately, including the dotted temp-name shape, so the two stores remain recognisably the same mechanism.

**No `fsync`.** The precedent store does not fsync, and diverging would leave two similar stores with different durability characteristics for no stated reason. Adding it is a separate, cross-store decision.

**No injectable filesystem.** `SessionMetadataStore` needs one for unrelated reasons. `ProjectStore` tests already use a real `mkdtemp`, and a real-filesystem test proves the rename semantics an injected fake could only assert about.

**The serialization queue stays.** It prevents lost updates between concurrent mutations, which is a different failure from a torn write. `rename` does not subsume it.

Orphaned `.tmp` files after a hard crash are acceptable and harmless: the read path only opens the canonical filename, and the dot prefix keeps them out of casual directory listings. This matches `SessionMetadataStore` exactly.

### F-3: a typed not-found error at the `ProjectService` boundary

Add `ProjectNotFoundError extends Error` in `projectService.ts`. `close`, `requireProject`, and the private `setPinned` throw it instead of a bare `Error`.

Add a `sendProjectRouteError(reply, error)` helper in `app.ts` mapping `ProjectNotFoundError → 404` and anything else `→ 500`, following the existing `sendSkillsError` precedent in `skillsConfigRoutes.ts`. All four handlers above route through it.

**Scope boundary: the `ProjectService` contract, not every `requireProject` consumer.** `resolveWorkspaceContext` feeds roughly 17 handlers across `gitRoutes`, `terminalProxyRoutes`, and `workspaceExplorerRoutes`, plus `workspaceDeletionRoutes`. Those catch blocks also absorb workspace-not-found and git failures, so each needs its own status decision and test updates — a separate change with a much larger blast radius, none of it implicated by pinning.

The type change is additive for those sites: their catch-alls keep catching everything and keep returning 404 exactly as today. No caller is left half-migrated.

**Accepted behavior change.** `GET /projects/:projectId/workspaces` currently answers 404 when workspace listing itself fails; it will answer 500. This is the intended correction — a disk or git failure is not "not found". Client code does not branch on status for these routes, so it surfaces as a different error message rather than a broken flow. No existing test asserts the old behavior. Approved explicitly by the requester.

## Testing

- `projectStore.test.ts`: a completed write leaves no `.tmp` file behind; a pre-existing unrelated `.tmp` file does not affect a later read; existing pin, ordering, and overlapping-mutation lock tests continue to pass.
- `projectService.test.ts`: `close`, `requireProject`, `pin`, and `unpin` reject with `ProjectNotFoundError` for an unknown id.
- `app.projects.test.ts`: unknown ids still yield 404 with the same body on all four routes; a store failure yields 500, proving the two paths are now distinguishable.

## Out of scope

- Converting `resolveWorkspaceContext` consumers to typed errors.
- `fsync` on either store.
- Pin controls on archived session rows (reviewed, accepted as designed).
- Clearing persisted session pin metadata on archive.
- Capability-gating project pinning for older remote machines; session pinning is not gated either.
