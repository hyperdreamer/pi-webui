# Passive Update Detection Design

**Date:** 2026-07-31

## Goal

Make PI WEBUI discover new npm releases more promptly through its existing passive status-refresh flow, without adding update-panel interactions or changing update messaging.

## Decision

The change is intentionally limited to two runtime decisions:

1. Keep the browser's existing PI WEBUI status refresh interval at 15 minutes.
2. Reduce the server's npm release-lookup cache lifetime from six hours to 15 minutes.

The browser interval in `src/client/src/components/PiWebUiApp.ts` already implements the first decision, so it requires no production-code change. The server default in `src/server/piWebUiReleaseLookupCache.ts` implements the second decision and is the only runtime value that changes.

## Behavior

While at least one PI WEBUI browser client is active, it continues requesting status every 15 minutes. A status refresh consults the server's in-memory release-lookup cache. The first lookup after that cache has been stale for 15 minutes queries the npm registry; concurrent callers continue sharing the same pending lookup.

The server does not gain a background timer. Each PI WEBUI gateway process owns its own demand-driven cache, and restarting that process clears the cache. If no browser client or other status caller is active, no periodic npm request occurs.

The outer PI WEBUI status cache retains its existing 60-second stale-while-revalidate behavior. Consequently, the browser request that causes a fresh npm lookup can receive the previous status snapshot while the server refreshes in the background. With no intervening status request, a new release can become visible on the following browser poll, giving an expected passive detection window of roughly 15–30 minutes. Browser suspension, timer throttling, offline mode, and network failure can extend that window.

## Unchanged behavior

This design does not change:

- Updates panel visibility, badges, messages, or accessibility labels;
- panel-selection behavior, spinners, or buttons;
- the existing forced update-check action;
- the one-minute outer status-cache policy;
- npm lookup timeout, error, offline, or skip behavior;
- installation detection, update commands, or restart guidance;
- client or server configuration.

## Tests and verification

Add focused coverage in `src/server/piWebUiReleaseLookupCache.test.ts` proving that the default cache lifetime:

- serves the cached release result immediately before 15 minutes; and
- performs a new lookup once 15 minutes have elapsed.

Run the focused test first, then typecheck and the repository verification suite. Use `git diff --check` before completion.

## Release notes and documentation

Add a patch Changeset describing the faster passive release detection. Do not edit `CHANGELOG.md` manually. No README or user-facing documentation expansion is needed because this changes only the polling/cache cadence and introduces no user-operated feature or configuration.

## Non-goals

- Strictly guaranteeing that a release appears within 15 minutes.
- Forcing an npm lookup from every browser timer tick.
- Adding a configurable polling or cache interval.
- Persisting release status outside the existing in-memory caches.
- Refactoring the status controller, status cache, update plugin, or plugin API.
