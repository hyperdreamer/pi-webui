# Active projects first — design

## Goal

In the Projects navigation list, show any project with live activity before inactive projects. Live activity includes active sessions and terminals, including activity attributed to a project through a known worktree.

## Decision

Order projects at the `ProjectList` presentation boundary. The list will be a stable partition:

1. projects for which the existing `projectActivityIndicator()` returns an activity kind;
2. all remaining projects.

Within each group, retain the incoming project order. This means several simultaneously active projects do not jump around based on update timestamps, and inactive projects preserve their familiar order.

## Data flow

`AppNavigationPanel` already provides `ProjectList` with:

- `projects` — the stored/API project order;
- `workspacesByProjectId` — known workspace and worktree ownership;
- `activities` — current workspace activity.

`ProjectList` will derive its rendered rows from those inputs. It will reuse `projectActivityIndicator()` rather than create another activity-ownership rule. When the activity map changes, Lit re-renders and recalculates the derived order. No client state, API response, server store, or persisted ordering is mutated.

Search remains intact: filter the project list using the existing search behavior, then apply the stable active-first ordering to the visible results. Selection, keyboard navigation, row actions, and the activity indicator remain unchanged.

## Alternatives considered

- **Mutating `AppState.projects` on activity changes:** rejected because list presentation would alter shared navigation state and introduce unnecessary ordering churn.
- **Persisting a priority or activity timestamp in the project store:** rejected because live status must not become stale and requires unnecessary API/storage changes.

## Error handling

This is a pure, synchronous display derivation over data already available to the component. It introduces no network or persistence operation and therefore no new error path. Existing activity ownership discovery remains responsible for attributing worktree activity.

## Verification

Add focused `ProjectList` tests that verify:

- projects with session activity appear before inactive projects;
- projects with terminal activity appear before inactive projects;
- active and inactive groups each preserve their input order;
- the ordering helper does not mutate the supplied project array;
- existing project filtering remains compatible with the derived order.

Run the focused test file, typecheck, lint the changed source/test files, and the repository verification suite before review.

## Scope boundaries

- No server, API, storage, session-daemon, or configuration changes.
- No visual redesign or new indicator.
- Add a patch Changeset for this user-visible navigation behavior; do not edit `CHANGELOG.md` directly.
