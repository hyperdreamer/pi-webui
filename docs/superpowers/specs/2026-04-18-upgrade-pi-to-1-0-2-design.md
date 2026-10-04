# Upgrade Pi Modules to 1.0.2 Design

**Date:** 2026-04-18
**Topic:** Upgrade Pi Packages to 1.0.2

## 1. Objective & Scope

Upgrade the core `@earendil-works` Pi dependencies to the latest release (`1.0.2`):
- `@earendil-works/pi-agent-core`: `^1.0.2` (currently `^0.87.1`)
- `@earendil-works/pi-ai`: `^1.0.2` (currently `^0.87.1`)
- `@earendil-works/pi-coding-agent`: `^1.0.2` (currently `^0.87.1`)

Update `peerDependencies` in `package.json` to accept `>=1.0.0 <2` (or `>=1.0.2 <2`).

Verify compatibility across all consuming services, types, test suites, and documentation/changeset requirements.

## 2. Architecture & Compatibility Boundaries

The `@earendil-works` packages interface with `pi-webui` primarily in:
- `src/server/sessions/piSessionService.ts` & gateway implementations (`piSessionManagerGateway.ts`): session creation, lifecycle events, model policy resolution, tools, prompt queues.
- `src/server/models/modelsConfigService.ts` & `src/server/sessions/modelTierRegistry.ts`: models & provider catalogs.
- `src/server/sessions/plainTextTheme.ts`: theme & styling interfaces.
- `src/server/sessions/attachmentService.ts`: attachment conversion and prompt payloads.
- `extensions/pi-webui.ts`: Pi extensions entry points.
- Rate limits and usage metrics adapters (`src/server/rateLimits/`, `src/server/usage/`).

## 3. Plan & Verification Steps

1. Branch creation: `bump-pi-1.0.2`.
2. Update `package.json` dependencies and `peerDependencies`, run `npm install`.
3. Run `npm run typecheck` to expose any TypeScript compiler breakages or type drift.
4. Adapt any broken method signatures, types, or event listeners in `src/server/` or `extensions/`.
5. Run Vitest test suites (`npm run test:fast` / `npm run test:serial`).
6. Run `npm run lint` and `npm run knip`.
7. Generate a Changeset recording the dependency and peerDependency upgrades.
8. Verify clean build (`npm run build`).

## 4. Error Handling & Rollback

If upstream `1.0.2` introduces architectural incompatibilities or breaking runtime regressions that require upstream fixes, the feature branch can be isolated or rolled back cleanly without affecting `main`.
