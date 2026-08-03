# Starter Screen Notice Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give starter-originated failures and refusals one scoped notice channel that never unmounts the new-session start screen and never goes silent when a session is selected.

**Architecture:** A pure `starterNotice` module owns the notice type and the decision of what text is visible for a given notice, scope, and live blocked reason. `PiWebUiApp` holds one `starterNotice` field outside `AppState`, so it structurally cannot reach `shouldShowSessionStartScreen()`, and renders it in `<main>` as a sibling of the `state.error` banner. The three starter paths that currently write `state.error` publish through that channel instead.

**Tech Stack:** TypeScript, Lit, Vitest, Changesets.

## Global Constraints

- The approved specification is `docs/superpowers/specs/2026-08-03-starter-screen-notice-channel-design.md`; preserve its domain terms and acceptance criteria.
- Node.js `22.19.0` is the runtime floor; do not use APIs newer than that.
- Add no runtime dependency, no toast system, and no notification centre.
- Leave `shouldShowSessionStartScreen()` byte-for-byte unchanged. It must keep consulting `state.error`.
- No starter-originated code path may write `state.error`. `state.error` keeps serving machine dialogs, workspace deletion, terminal command failures, and remote route restore.
- A starter notice must never block Start. Only `starterModelPolicyInputs()?.status.blockedReason` blocks, through the existing `.sendDisabled` binding and `starterModelPolicyBlocksStart()`.
- Do not change what counts as a blocked starter policy: `starterModelPolicyInputs()` and `starterModelPolicyError()` keep their current semantics and priority order.
- An unavailable remembered tier stays selected and blocks Start with no substitution of another tier, Exact mode, model, or thinking level.
- A `"policy-blocked"` notice must never carry captured text. Its message is read live from `starterModelPolicyInputs()?.status.blockedReason` at render time.
- Every new assertion must be proven falsifiable by mutation, in the same task that adds it. Restoring a `setState({ error })` write must fail its test; deleting the notice render must fail the visibility tests.
- Do not manually edit `CHANGELOG.md`; add one patch Changeset for the user-visible fix.
- No `src/server/` change is expected, so no session daemon restart should be required. If a task does touch `src/server/`, say so in its report.
- Spec line-number drift to expect: the spec attributes the `state.error` write at `PiWebUiApp.ts:3186` to `loadStarterSessionDefaults()`, but that line is the catch of `updateStarterSessionDefaults()`. The real `loadStarterSessionDefaults()` catch only calls `console.warn`. Task 2 redirects the `state.error` write and gives the silent load catch the same notice.

## Task 1: Pure starter notice module

**Implementer tier:** Fast

**Files:**

- Create: `src/client/src/components/starterNotice.ts`
- Test: `src/client/src/components/starterNotice.test.ts`

**Interfaces:**

- Consumes: nothing. This module imports nothing and is the first task.
- Produces: `StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed"`.
- Produces: `StarterNoticeScope = { machineId: string; workspaceId: string }`.
- Produces: `StarterNotice = { kind: StarterNoticeKind; message?: string; scope: StarterNoticeScope }`.
- Produces: `starterPolicyBlockedNotice(scope: StarterNoticeScope): StarterNotice`.
- Produces: `starterFailureNotice(kind: "start-failed" | "defaults-failed", message: string, scope: StarterNoticeScope): StarterNotice`.
- Produces: `starterNoticeVisibleText(notice: StarterNotice | undefined, currentScope: StarterNoticeScope | undefined, liveBlockedReason: string | undefined): string | undefined`.
- Produces: `shouldRetainStarterNotice(notice: StarterNotice, currentScope: StarterNoticeScope | undefined, liveBlockedReason: string | undefined): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/starterNotice.test.ts` with exactly this content:

```ts
import { describe, expect, it } from "vitest";
import {
  shouldRetainStarterNotice,
  starterFailureNotice,
  starterNoticeVisibleText,
  starterPolicyBlockedNotice,
} from "./starterNotice";

const scope = { machineId: "local", workspaceId: "workspace-a" };
const otherWorkspace = { machineId: "local", workspaceId: "workspace-b" };
const otherMachine = { machineId: "remote-a", workspaceId: "workspace-a" };

describe("starterPolicyBlockedNotice", () => {
  it("captures no message, so its text can only be read live", () => {
    expect(starterPolicyBlockedNotice(scope)).toEqual({ kind: "policy-blocked", scope });
  });
});

describe("starterNoticeVisibleText", () => {
  it("reads a policy-blocked message from the live reason", () => {
    const notice = starterPolicyBlockedNotice(scope);
    expect(starterNoticeVisibleText(notice, scope, "Choose a valid model tier")).toBe("Choose a valid model tier");
    expect(starterNoticeVisibleText(notice, scope, "A different live reason")).toBe("A different live reason");
  });

  it("shows nothing for a policy-blocked notice once the live reason is gone", () => {
    expect(starterNoticeVisibleText(starterPolicyBlockedNotice(scope), scope, undefined)).toBeUndefined();
    expect(starterNoticeVisibleText(starterPolicyBlockedNotice(scope), scope, "")).toBeUndefined();
  });

  it("shows the captured message for a failure, with no live reason available", () => {
    const notice = starterFailureNotice("start-failed", "Could not start the session. offline", scope);
    expect(starterNoticeVisibleText(notice, scope, undefined)).toBe("Could not start the session. offline");
  });

  it("ignores a live reason when the notice carries its own message", () => {
    const notice = starterFailureNotice("defaults-failed", "Could not load starter defaults. offline", scope);
    expect(starterNoticeVisibleText(notice, scope, "Choose a valid model tier")).toBe("Could not load starter defaults. offline");
  });

  it("shows nothing outside the notice's own machine and workspace", () => {
    const blocked = starterPolicyBlockedNotice(scope);
    const failed = starterFailureNotice("start-failed", "offline", scope);
    expect(starterNoticeVisibleText(blocked, otherWorkspace, "Choose a valid model tier")).toBeUndefined();
    expect(starterNoticeVisibleText(blocked, otherMachine, "Choose a valid model tier")).toBeUndefined();
    expect(starterNoticeVisibleText(failed, otherWorkspace, undefined)).toBeUndefined();
    expect(starterNoticeVisibleText(failed, undefined, undefined)).toBeUndefined();
  });

  it("shows nothing when there is no notice", () => {
    expect(starterNoticeVisibleText(undefined, scope, "Choose a valid model tier")).toBeUndefined();
  });
});

describe("shouldRetainStarterNotice", () => {
  it("drops a policy-blocked notice as soon as the live reason is repaired", () => {
    const notice = starterPolicyBlockedNotice(scope);
    expect(shouldRetainStarterNotice(notice, scope, "Choose a valid model tier")).toBe(true);
    expect(shouldRetainStarterNotice(notice, scope, undefined)).toBe(false);
  });

  it("keeps a failure notice, which describes a past event with no live source", () => {
    const notice = starterFailureNotice("start-failed", "offline", scope);
    expect(shouldRetainStarterNotice(notice, scope, undefined)).toBe(true);
  });

  it("drops any notice that no longer matches the selected machine and workspace", () => {
    expect(shouldRetainStarterNotice(starterPolicyBlockedNotice(scope), otherWorkspace, "reason")).toBe(false);
    expect(shouldRetainStarterNotice(starterFailureNotice("defaults-failed", "offline", scope), otherMachine, undefined)).toBe(false);
    expect(shouldRetainStarterNotice(starterFailureNotice("defaults-failed", "offline", scope), undefined, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/client/src/components/starterNotice.test.ts`

Expected: FAIL, `Failed to resolve import "./starterNotice"`.

- [ ] **Step 3: Write the implementation**

Create `src/client/src/components/starterNotice.ts` with exactly this content:

```ts
/**
 * A starter notice reports that a starter action failed or was refused while the
 * starter context itself stays valid and repairable.
 *
 * It is deliberately not part of `AppState`. `shouldShowSessionStartScreen()`
 * requires `state.error === ""`, so publishing a starter message there unmounts
 * the composer, the model-policy pill, and the tier menu — the controls that
 * repair the condition being reported.
 */
export type StarterNoticeKind = "policy-blocked" | "start-failed" | "defaults-failed";

/** The machine and workspace a notice belongs to. */
export interface StarterNoticeScope {
  machineId: string;
  workspaceId: string;
}

export interface StarterNotice {
  kind: StarterNoticeKind;
  /** Fixed text for failures; omitted when the reason is read live. */
  message?: string;
  scope: StarterNoticeScope;
}

/**
 * A refused start carries no captured text. Its message is read live from the
 * current `blockedReason` at render time, so repairing the ladder or choosing a
 * valid tier retires it on the next render with no stale string. A captured copy
 * would reintroduce exactly that staleness, which is why this factory exists
 * instead of a general constructor callers could hand a message to.
 */
export function starterPolicyBlockedNotice(scope: StarterNoticeScope): StarterNotice {
  return { kind: "policy-blocked", scope };
}

/**
 * A failed start or defaults load describes a past event with no live source to
 * re-read, so its text is captured once.
 */
export function starterFailureNotice(
  kind: "start-failed" | "defaults-failed",
  message: string,
  scope: StarterNoticeScope,
): StarterNotice {
  return { kind, message, scope };
}

/**
 * The text to render for `notice` right now, or undefined when it must not be
 * shown at all: a different machine or workspace is selected, a policy-blocked
 * notice has no live reason left, or the notice carries no usable text.
 */
export function starterNoticeVisibleText(
  notice: StarterNotice | undefined,
  currentScope: StarterNoticeScope | undefined,
  liveBlockedReason: string | undefined,
): string | undefined {
  if (notice === undefined || !inScope(notice, currentScope)) return undefined;
  const text = notice.kind === "policy-blocked" ? liveBlockedReason : notice.message;
  return text === undefined || text === "" ? undefined : text;
}

/**
 * Whether `notice` survives into the next render.
 *
 * A policy-blocked notice is dropped, not merely hidden, once its live reason is
 * gone: it then means strictly "the user's last Start attempt was refused" and
 * cannot reappear after an external repair without a fresh attempt.
 */
export function shouldRetainStarterNotice(
  notice: StarterNotice,
  currentScope: StarterNoticeScope | undefined,
  liveBlockedReason: string | undefined,
): boolean {
  if (!inScope(notice, currentScope)) return false;
  if (notice.kind !== "policy-blocked") return true;
  return liveBlockedReason !== undefined && liveBlockedReason !== "";
}

function inScope(notice: StarterNotice, currentScope: StarterNoticeScope | undefined): boolean {
  return currentScope !== undefined
    && notice.scope.machineId === currentScope.machineId
    && notice.scope.workspaceId === currentScope.workspaceId;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/client/src/components/starterNotice.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 5: Prove the live-read assertions are falsifiable**

In `starterNoticeVisibleText`, temporarily replace the `text` line with a captured-copy mutation:

```ts
  const text = notice.message;
```

Run: `npm test -- --run src/client/src/components/starterNotice.test.ts`

Expected: FAIL, "reads a policy-blocked message from the live reason" reports `undefined` instead of the live reason. Revert the mutation and confirm the suite passes again.

Then mutate `shouldRetainStarterNotice` to always retain:

```ts
  if (notice.kind !== "policy-blocked") return true;
  return true;
```

Expected: FAIL, "drops a policy-blocked notice as soon as the live reason is repaired". Revert and confirm the suite passes again.

- [ ] **Step 6: Check types, lint, and unused exports**

Run:

```bash
npx tsc --noEmit
npx eslint src/client/src/components/starterNotice.ts src/client/src/components/starterNotice.test.ts
npx knip
```

Expected: all three clean. Knip must report no unused export for this module; its test file is a Knip entry point.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/starterNotice.ts src/client/src/components/starterNotice.test.ts
git commit -m "feat: add a pure starter notice channel module"
```

## Task 2: Route every starter path through the notice channel

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:8-10` (add the module import)
- Modify: `src/client/src/components/PiWebUiApp.ts:356-360` (replace the boolean flag)
- Modify: `src/client/src/components/PiWebUiApp.ts:1165-1191` (`loadStarterSessionDefaults` success clear and catch)
- Modify: `src/client/src/components/PiWebUiApp.ts:1536-1541` (add scope and publish helpers)
- Modify: `src/client/src/components/PiWebUiApp.ts:1600-1605` (`resetStarterModelPolicyForScopeChange`)
- Modify: `src/client/src/components/PiWebUiApp.ts:1979-2002` (`startSessionAndOpenChat`)
- Modify: `src/client/src/components/PiWebUiApp.ts:2157-2182` (`renderSessionStartScreen`)
- Modify: `src/client/src/components/PiWebUiApp.ts:3167-3190` (`updateStarterSessionDefaults` success clear and catch)
- Modify: `src/client/src/components/PiWebUiApp.ts:3204-3227` (`handleStartSessionPrompt` blocked guard and catch)
- Modify: `src/client/src/components/PiWebUiApp.ts:3243-3250` (`setStarterModelPolicyDraft`)
- Modify: `src/client/src/components/PiWebUiApp.ts:3798-3802` (render the notice in `<main>`)
- Modify: `src/client/src/components/shared.ts:197`
- Modify: `src/client/src/components/shared.ts:204`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

**Interfaces:**

- Consumes from Task 1, all from `./starterNotice`: `StarterNotice = { kind: StarterNoticeKind; message?: string; scope: StarterNoticeScope }`, `StarterNoticeScope = { machineId: string; workspaceId: string }`, `starterPolicyBlockedNotice(scope: StarterNoticeScope): StarterNotice`, `starterFailureNotice(kind: "start-failed" | "defaults-failed", message: string, scope: StarterNoticeScope): StarterNotice`, `starterNoticeVisibleText(notice: StarterNotice | undefined, currentScope: StarterNoticeScope | undefined, liveBlockedReason: string | undefined): string | undefined`, and `shouldRetainStarterNotice(notice: StarterNotice, currentScope: StarterNoticeScope | undefined, liveBlockedReason: string | undefined): boolean`.
- Consumes existing private members of `PiWebUiApp`: `starterModelPolicyInputs()` returning `{ status: ClientSessionModelPolicyStatus; response: SessionModelPolicyResponse } | undefined` where `status.blockedReason?: string`, `starterModelPolicyBlocksStart(): boolean`, `starterModelPolicyPreferenceScope()`, and the module-level `errorMessage(error: unknown): string` defined at the bottom of `PiWebUiApp.ts`. `selectedMachineId(state)` is already imported there from `../controllers/types`.
- Consumes existing test helpers already present in `PiWebUiApp.sessionModelPolicy.test.ts`: `createApp()`, `starterState()`, `starterDefaults(overrides?)`, `invalidTierCatalog(tier, reason)`, `setAppState(app, state)`, `appState(app)`, `sessionController(app)`, `renderApp(app)`, `promptEditorTemplate(app)`, `templateValueAfterMarker(template, marker)`, `templateText(value)`, `findTemplateContaining(value, marker)`, `promptStartFrom(completion)`, `preferenceCapableStarterState()`, `loadStarterSessionDefaults(app, workspace)`, `startSessionAndOpenChat(app)`, `startSessionPrompt(app, text)`, `starterModelPolicy(app)`, `pickStarterModel(app, value)`, `stubComposerFocus(app)`, and `flush()`. `mainWorkspace` is a module constant in the same file. `templateText` and `findTemplateContaining` are already imported there from `../templateInspection.testSupport`; `modelTiersApi` is already imported from `../api`.
- Produces: private `starterNotice: StarterNotice | undefined` reactive field on `PiWebUiApp`.
- Produces: private `starterNoticeScope(): StarterNoticeScope | undefined`.
- Produces: private `publishStarterNotice(notice: StarterNotice): void`.
- Produces: private `renderStarterNotice()` returning a Lit template or `null`.
- Produces: the `.starter-notice` CSS class, replacing `.session-start-block-notice`.
- Removes: private `starterModelPolicyStartBlocked` and the `.session-start-block-notice` class. No other file references either name; verify with grep in Step 1.

### Site inventory

Four starter sites write a message today. Three write `state.error` and one is silent:

| Site | Today | After |
| --- | --- | --- |
| `startSessionAndOpenChat()` catch (`:1998`) | `setState({ error: String(error) })` | `"start-failed"` notice |
| `handleStartSessionPrompt` catch (`:3223`) | `setState({ error: String(error) })` | `"start-failed"` notice |
| `updateStarterSessionDefaults()` catch (`:3186`) | `setState({ error: String(error) })` | `"defaults-failed"` notice |
| `loadStarterSessionDefaults()` catch (`:1186`) | `console.warn` only, user sees nothing | `console.warn` plus a `"defaults-failed"` notice |

The spec's table attributes the `:3186` write to `loadStarterSessionDefaults()`. That is a naming slip in the spec: `:3186` is the catch of `updateStarterSessionDefaults()`, and the real load catch only warns. Both are redirected here, which is what the spec's acceptance criterion 7 requires.

One further site changes, beyond the spec's table. `handleStartSessionPrompt`'s blocked-start guard (`:3206`) returns in silence today, so a refusal reported through the composer's own send path produces no message at all; only `startSessionAndOpenChat()` raised the old flag. Step 6 gives it the same `"policy-blocked"` notice, so "a blocked start reports its reason" holds on both start paths. This is a deliberate extension of the spec, serving its acceptance criterion 3 and its goal that no invocation path is silent. Call it out in the task report.

- [ ] **Step 1: Confirm the names being removed are file-local**

Run:

```bash
grep -rn "starterModelPolicyStartBlocked\|session-start-block-notice" src/ docs/*.md docs/*.html
```

Expected: matches only in `src/client/src/components/PiWebUiApp.ts` (lines 358-360, 1603, 1982, 1985, 2176, 3247) and `src/client/src/components/shared.ts:197`, plus prose matches in `docs/superpowers/`. No test file and no shipped documentation page references either name, so the rename drags no test anchor. Record the exact match list in the task report.

- [ ] **Step 2: Write the failing tests**

Add this `describe` block to `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, immediately after the closing `});` of the existing `describe("PiWebUiApp starter policy blocking and diagnostics", ...)` block:

```ts
describe("PiWebUiApp starter notice channel", () => {
  it("reports a failed direct start without touching screen selection", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSession").mockRejectedValue(new Error("session daemon offline"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await startSessionAndOpenChat(app);
    await flush();

    // `shouldShowSessionStartScreen()` requires an empty `state.error`, so a
    // starter failure published there would unmount the composer the user needs
    // in order to retry.
    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("start-failed");
    expect(templateText(renderApp(app))).toContain("session daemon offline");
  });

  it("keeps the composer mounted and the draft intact after a failed prompt start", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSessionWithPrompt").mockRejectedValue(new Error("start request rejected"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    const draftBeforeStart = starterModelPolicy(app);

    startSessionPrompt(app, "explore the repo");
    await flush();

    expect(appState(app).error).toBe("");
    expect(starterModelPolicy(app)).toBe(draftBeforeStart);
    // Throws if the start screen stopped rendering its composer.
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSend=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("start request rejected");
  });

  it("reports a failed starter defaults update without unmounting the model controls", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionsApi, "updateSessionDefaults").mockRejectedValue(new Error("defaults store offline"));
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await pickStarterModel(app, "openai/gpt-advanced");

    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("defaults-failed");
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSelectModel=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("defaults store offline");
  });

  it("reports a failed starter defaults load instead of failing silently", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockRejectedValue(new Error("defaults unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("defaults-failed");
    // Pi's own defaults would still have started a session, so the composer that
    // picks a model must stay reachable.
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".onSend=")).toBeTypeOf("function");
    expect(templateText(renderApp(app))).toContain("defaults unavailable");
    expect(warn).toHaveBeenCalled();
  });

  // One markup anchor, kept deliberately narrow: the notice moved out of the
  // start-screen column into `<main>` and its class was renamed, so the CSS
  // contract and the alert role would otherwise be able to drift silently.
  it("renders the notice as an alert with the shared starter-notice class", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    vi.spyOn(sessionController(app), "startSession").mockRejectedValue(new Error("session daemon offline"));
    stubComposerFocus(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    await startSessionAndOpenChat(app);
    await flush();

    expect(findTemplateContaining(renderApp(app), 'class="starter-notice" role="alert"')).not.toBeUndefined();
  });

  it("reports a refusal on the composer send path, which used to return in silence", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    const startWithPrompt = vi.spyOn(sessionController(app), "startSessionWithPrompt")
      .mockImplementation(promptStartFrom(Promise.resolve(false)));
    stubComposerFocus(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    startSessionPrompt(app, "start with a broken tier");

    expect(startWithPrompt).not.toHaveBeenCalled();
    expect(appState(app).error).toBe("");
    expect(starterNotice(app)?.kind).toBe("policy-blocked");
    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");
  });

  it("retires a previous notice once a starter defaults load succeeds", async () => {
    const app = createApp();
    const defaults = vi.spyOn(sessionsApi, "sessionDefaults")
      .mockRejectedValueOnce(new Error("defaults unavailable"))
      .mockResolvedValue(starterDefaults());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setAppState(app, starterState());

    await loadStarterSessionDefaults(app, mainWorkspace);
    expect(starterNotice(app)?.kind).toBe("defaults-failed");

    await loadStarterSessionDefaults(app, mainWorkspace);

    expect(defaults).toHaveBeenCalledTimes(2);
    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("defaults unavailable");
  });
});
```

Then add this accessor beside the existing `starterModelPolicy` helper near the bottom of the same file:

```ts
function starterNotice(app: PiWebUiApp): StarterNotice | undefined {
  const value: unknown = Reflect.get(app, "starterNotice");
  if (value === undefined) return undefined;
  if (!isStarterNotice(value)) throw new Error("Starter notice has an unexpected shape");
  return value;
}

function isStarterNotice(value: unknown): value is StarterNotice {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const scope: unknown = Reflect.get(value, "scope");
  if (kind !== "policy-blocked" && kind !== "start-failed" && kind !== "defaults-failed") return false;
  if (typeof scope !== "object" || scope === null) return false;
  return typeof Reflect.get(scope, "machineId") === "string" && typeof Reflect.get(scope, "workspaceId") === "string";
}
```

Add `import type { StarterNotice } from "./starterNotice";` to that test file's imports.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

Expected: FAIL. The seven new tests fail; the redirected-site tests report `state.error` holding the error string or `starterNotice` being undefined, the send-path refusal test reports `starterNotice` undefined, and the markup anchor test reports `undefined`. Every pre-existing test in the file still passes.

- [ ] **Step 4: Replace the flag with the notice field**

In `PiWebUiApp.ts`, add to the imports beside the other `./` component imports (near line 9):

```ts
import { starterFailureNotice, starterNoticeVisibleText, starterPolicyBlockedNotice, type StarterNotice, type StarterNoticeScope } from "./starterNotice";
```

Do not import `shouldRetainStarterNotice` here. Task 3 adds it with its only call site; importing it now leaves an unused import that ESLint rejects.

Replace the flag declaration and its comment at lines 356-360:

```ts
  // A starter failure or refusal must report itself without leaving the start
  // screen, and without going silent when a session is selected in the same
  // workspace. `state.error` can do neither: `shouldShowSessionStartScreen()`
  // requires an empty `state.error`, so publishing there unmounts the very
  // controls that repair the condition. This field is held outside `AppState` so
  // it structurally cannot reach screen selection.
  @state() private starterNotice: StarterNotice | undefined;
```

- [ ] **Step 5: Add the scope and publish helpers**

Insert these two methods immediately after `starterModelPolicyPreferenceScope()` (which ends at line 1540):

```ts
  private starterNoticeScope(): StarterNoticeScope | undefined {
    const workspace = this.state.selectedWorkspace;
    if (workspace === undefined) return undefined;
    return { machineId: selectedMachineId(this.state), workspaceId: workspace.id };
  }

  private publishStarterNotice(notice: StarterNotice): void {
    this.starterNotice = notice;
  }
```

- [ ] **Step 6: Redirect the four starter sites**

In `resetStarterModelPolicyForScopeChange()` (line 1603), replace the flag reset:

```ts
    this.starterNotice = undefined;
```

In `loadStarterSessionDefaults()`, extend the catch at lines 1186-1189 so the silent failure reports itself, and clear a previous notice once a load resolves. Add the clear immediately after the existing in-scope guard that assigns `this.starterSessionDefaults = defaults;` (line 1170):

```ts
      this.starterSessionDefaults = defaults;
      this.starterNotice = undefined;
```

```ts
    } catch (error) {
      if (selectedMachineId(this.state) === machineId && this.state.selectedWorkspace?.id === workspace.id) {
        console.warn("Failed to load Pi session defaults", error);
        this.publishStarterNotice(starterFailureNotice(
          "defaults-failed",
          `Could not load this workspace's model defaults. ${errorMessage(error)}`,
          { machineId, workspaceId: workspace.id },
        ));
      }
    }
```

In `startSessionAndOpenChat()`, replace lines 1980-1985 and the catch at line 1998:

```ts
    const blockedReason = this.starterModelPolicyInputs()?.status.blockedReason;
    if (blockedReason !== undefined) {
      const scope = this.starterNoticeScope();
      if (shouldComplete() && scope !== undefined) this.publishStarterNotice(starterPolicyBlockedNotice(scope));
      return;
    }
    this.starterNotice = undefined;
```

```ts
    }).catch((error: unknown) => {
      const scope = workspaceId === undefined ? undefined : { machineId: startMachineId, workspaceId };
      if (shouldComplete() && scope !== undefined) {
        this.publishStarterNotice(starterFailureNotice("start-failed", `Could not start the session. ${errorMessage(error)}`, scope));
      }
    });
```

`startMachineId` is a new local captured beside `workspaceId`, in the same synchronous block, so a machine switch during the start cannot mislabel the notice:

```ts
    const workspaceId = this.state.selectedWorkspace?.id;
    const startMachineId = selectedMachineId(this.state);
```

In `updateStarterSessionDefaults()`, clear a previous notice once the update resolves, immediately after the in-scope `this.starterSessionDefaults = defaults;` assignment (line 3176):

```ts
      this.starterSessionDefaults = defaults;
      this.starterNotice = undefined;
```

Then replace the catch at line 3186:

```ts
    } catch (error) {
      if (selectedMachineId(this.state) === machineId && this.state.selectedWorkspace?.id === workspace.id) {
        this.publishStarterNotice(starterFailureNotice(
          "defaults-failed",
          `Could not save this workspace's model defaults. ${errorMessage(error)}`,
          { machineId, workspaceId: workspace.id },
        ));
      }
    }
```

In `handleStartSessionPrompt`, the blocked-start guard at line 3206 currently returns in silence, so a refusal on this path reports nothing. Give it the same notice the other start path raises, and retire a previous notice only once a start is actually being attempted. Order matters: clearing before the guard would wipe a live refusal and leave the user with nothing.

```ts
    if (this.starterModelPolicyBlocksStart()) {
      const scope = this.starterNoticeScope();
      if (scope !== undefined) this.publishStarterNotice(starterPolicyBlockedNotice(scope));
      return;
    }
    this.starterNotice = undefined;
```

Then capture the notice scope beside the existing `workspaceId` and replace the catch at lines 3222-3224:

```ts
    const workspaceId = this.state.selectedWorkspace?.id;
    const startMachineId = selectedMachineId(this.state);
```

```ts
    ).catch((error: unknown) => {
      if (workspaceId === undefined) return;
      this.publishStarterNotice(starterFailureNotice(
        "start-failed",
        `Could not start the session. ${errorMessage(error)}`,
        { machineId: startMachineId, workspaceId },
      ));
    });
```

In `setStarterModelPolicyDraft()` (line 3247), replace the flag reset, keeping the comment's meaning:

```ts
    // Any explicit starter edit is a fresh attempt at a valid choice, so it
    // retires the previous refusal notice. A policy-blocked notice is
    // additionally gated on the live block, so a repair retires it even without
    // this reset.
    this.starterNotice = undefined;
```

- [ ] **Step 7: Render the notice in `<main>` and remove the start-screen copy**

Delete line 2176 entirely, the `${this.starterModelPolicyStartBlocked && ...}` line inside `renderSessionStartScreen()`. The start screen no longer renders the notice; `<main>` does, so it stays visible in both views.

Add `renderStarterNotice()` immediately before `renderSessionStartScreen()` (line 2157):

```ts
  /**
   * The starter notice renders as a sibling of the `state.error` banner rather
   * than inside `renderSessionStartScreen()`, so it is visible whether or not a
   * session is selected. A notice confined to the start screen produces no output
   * at all when `render()` takes the `state.selectedSession` branch, which made
   * "New session" with an unusable remembered tier completely inert.
   *
   * A policy-blocked notice reads its text live, so repairing the ladder or
   * choosing a valid tier retires it on the next render with no stale string.
   */
  private renderStarterNotice() {
    const text = starterNoticeVisibleText(
      this.starterNotice,
      this.starterNoticeScope(),
      this.starterModelPolicyInputs()?.status.blockedReason,
    );
    if (text === undefined) return null;
    return html`<p class="starter-notice" role="alert">${text}</p>`;
  }
```

In `render()`, add the call directly after the error banner at line 3800:

```ts
          ${state.error ? html`<div class="error">${state.error}</div>` : null}
          ${this.renderStarterNotice()}
```

Both render. They describe different things, and suppressing either would hide information the user needs.

- [ ] **Step 8: Rename the CSS class**

In `src/client/src/components/shared.ts`, replace line 197:

```ts
  .starter-notice { margin: 0; padding: 10px 16px; border-bottom: 1px solid var(--pi-border); color: var(--pi-danger); font-size: 13px; line-height: 1.45; }
```

The notice now sits in the `<main>` column beside `.error` (line 204) rather than in the start screen's centred content column, so it takes `.error`'s padding and bottom border instead of the old `-4px` margin that tucked it under the composer. Keep it in the same block of session-start rules so the two related classes stay together.

- [ ] **Step 9: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.onboarding.test.ts src/client/src/components/starterNotice.test.ts`

Expected: PASS, all files. The pre-existing test "keeps the start screen and its repair controls mounted after a blocked direct start" must still pass unchanged: its `expect(appState(app).error).toBe("")` and its `toContain("Choose a valid model tier before starting")` both hold through the new channel.

- [ ] **Step 10: Prove the redirected writes are falsifiable**

Restore the old write in `startSessionAndOpenChat()`'s catch, keeping the new one:

```ts
      if (shouldComplete()) this.setState({ error: String(error) });
```

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

Expected: FAIL, "reports a failed direct start without touching screen selection" reports a non-empty `state.error`. Revert.

Repeat for `handleStartSessionPrompt` (expect "keeps the composer mounted and the draft intact after a failed prompt start" to fail), then `updateStarterSessionDefaults` (expect "reports a failed starter defaults update without unmounting the model controls" to fail). Revert each mutation and confirm the suite passes again before the next one.

- [ ] **Step 11: Prove the notice render is falsifiable**

Replace the body of `renderStarterNotice()` with `return null;`.

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

Expected: FAIL, at least four tests: the three redirected-site tests lose their `toContain` text, the markup anchor test finds no template, and the pre-existing blocked-start tests lose "Choose a valid model tier before starting". Revert and confirm the suite passes again.

Record every mutation, the tests it broke, and the restored-green result in the task report. A mutation that breaks nothing means the assertion pins nothing and the test must be strengthened before this task is done.

- [ ] **Step 12: Check the whole client and the removed names**

Run:

```bash
grep -rn "starterModelPolicyStartBlocked\|session-start-block-notice" src/
npx tsc --noEmit
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/shared.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
npx knip
npm test
```

Expected: the grep returns nothing; typecheck, ESLint, and Knip clean; the full Vitest suite passes.

- [ ] **Step 13: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/shared.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "fix: report starter failures without unmounting the start screen"
```

## Task 3: Prove the policy-blocked notice reads live and retires

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts:8-10` (extend the `./starterNotice` import)
- Modify: `src/client/src/components/PiWebUiApp.ts:454-458` (`willUpdate`)
- Modify: `src/client/src/components/PiWebUiApp.ts:1536-1552` (add `syncStarterNotice` beside the scope helpers)
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

**Interfaces:**

- Consumes from Task 1, from `./starterNotice`: `shouldRetainStarterNotice(notice: StarterNotice, currentScope: StarterNoticeScope | undefined, liveBlockedReason: string | undefined): boolean`, where `StarterNotice = { kind: "policy-blocked" | "start-failed" | "defaults-failed"; message?: string; scope: StarterNoticeScope }` and `StarterNoticeScope = { machineId: string; workspaceId: string }`.
- Consumes from Task 2, all private members of `PiWebUiApp`: the `@state() private starterNotice: StarterNotice | undefined` field, `starterNoticeScope(): StarterNoticeScope | undefined`, `publishStarterNotice(notice: StarterNotice): void`, and `renderStarterNotice()` returning a Lit template or `null`. Task 2 also already imports `starterFailureNotice`, `starterNoticeVisibleText`, `starterPolicyBlockedNotice`, `StarterNotice`, and `StarterNoticeScope` from that module; add `shouldRetainStarterNotice` to the same import statement.
- Consumes from Task 2's test file, already present: the file-local `starterNotice(app: PiWebUiApp): StarterNotice | undefined` accessor and its `isStarterNotice` type guard.
- Consumes existing test helpers in that file: `createApp()`, `starterState()`, `preferenceCapableStarterState()`, `starterDefaults(overrides?)`, `validCatalog()`, `invalidTierCatalog(tier, reason)`, `activeSession()`, `activeStatus(policy)`, `exactPolicyStatus()`, `setAppState(app, state)`, `appState(app)`, `sessionController(app)`, `renderApp(app)`, `promptEditorTemplate(app)`, `templateValueAfterMarker(template, marker)`, `templateText(value)`, `policyStatus(value)`, `deferred<T>()` returning `{ promise, resolve, reject }`, `loadStarterSessionDefaults(app, workspace)`, `loadModelTierCatalog(app, machineId)`, `setModelTierCatalog(app, catalog, machineId)`, `startSessionAndOpenChat(app)`, `startSessionPrompt(app, text)`, `selectPolicyTier(app, tier)`, `handleWorkspaceChange(app, previous, next)`, `handleMachineChange(app, previous, next)`, `stubWorkspaceChangeSideEffects(app)`, `stubMachineChangeSideEffects(app)`, `stubComposerFocus(app)`, `setRouteRestoreInProgress(app)`, and `flush()`. Existing fixtures `mainWorkspace`, `featureWorkspace`, and `remoteMachine` are module constants in the same file.
- Produces: private `syncStarterNotice(): void` on `PiWebUiApp`, called from `willUpdate()`.
- Produces: a file-local test helper `runWillUpdate(app: PiWebUiApp): void`.

### Why this is its own task

Task 2 makes the notice visible. This task pins the property that makes `"policy-blocked"` different from the two failure kinds: it holds no text of its own, so its message can only ever be the current `blockedReason`, and it retires the moment that reason is gone. Both halves are easy to satisfy accidentally with a captured string that happens to match the live one in a single-render test, which is how FRR-1 reached a final review gate. The mutations in Step 6 are the point of the task.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`, after the `describe("PiWebUiApp starter notice channel", ...)` block Task 2 added:

```ts
describe("PiWebUiApp policy-blocked starter notice", () => {
  it("reports a refused start while a session is selected in the same workspace", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    await startSessionAndOpenChat(app);

    // FRR-1: `render()` now takes the `state.selectedSession` branch, so a notice
    // confined to the start screen would produce no output anywhere and "New
    // session" would be completely inert.
    const session = activeSession();
    setAppState(app, {
      ...preferenceCapableStarterState(),
      sessions: [session],
      selectedSession: session,
      status: activeStatus(exactPolicyStatus()),
    });

    expect(start).not.toHaveBeenCalled();
    expect(appState(app).error).toBe("");
    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");
  });

  it("tracks the live blocked reason instead of a string captured at refusal time", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    await startSessionAndOpenChat(app);

    expect(templateText(renderApp(app))).toContain("Choose a valid model tier before starting");

    // The same refusal, reported by a catalog that now explains itself. No new
    // Start attempt happens, so a captured string would still show the old text.
    setModelTierCatalog(app, {
      ...invalidTierCatalog("advanced", "Advanced points to a missing model"),
      configError: "The model tier file could not be parsed",
    }, "local");

    const text = templateText(renderApp(app));
    expect(text).toContain("The model tier file could not be parsed");
    expect(text).not.toContain("Choose a valid model tier before starting");
  });

  it("retires the notice when an external repair removes the block, with no starter edit", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    await startSessionAndOpenChat(app);
    expect(starterNotice(app)?.kind).toBe("policy-blocked");

    // The ladder is repaired outside the composer; the user makes no starter edit.
    setModelTierCatalog(app, validCatalog(), "local");
    runWillUpdate(app);

    // Dropped, not merely hidden: the notice must not reappear if the ladder
    // breaks again without a fresh Start attempt.
    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("Choose a valid model tier before starting");
    expect(policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus=")).blockedReason).toBeUndefined();
  });

  it("keeps blocking Start with the remembered tier selected while the notice is live", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    const start = vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();

    await startSessionAndOpenChat(app);
    await startSessionAndOpenChat(app);

    // The notice never unblocks or substitutes anything; only `blockedReason` gates
    // Start, and the unavailable remembered tier stays selected.
    expect(start).not.toHaveBeenCalled();
    const status = policyStatus(templateValueAfterMarker(promptEditorTemplate(app), ".modelPolicyStatus="));
    expect(status.mode).toBe("tiered");
    expect(status.tier).toBe("advanced");
    expect(templateValueAfterMarker(promptEditorTemplate(app), ".sendDisabled=")).toBe(true);
  });

  it("does not render a notice raised in another workspace or on another machine", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    stubWorkspaceChangeSideEffects(app);
    stubMachineChangeSideEffects(app);
    setRouteRestoreInProgress(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    await startSessionAndOpenChat(app);
    expect(starterNotice(app)?.scope).toEqual({ machineId: "local", workspaceId: mainWorkspace.id });

    const beforeWorkspace = appState(app);
    const featureState: AppState = {
      ...beforeWorkspace,
      workspaces: [mainWorkspace, featureWorkspace],
      selectedWorkspace: featureWorkspace,
    };
    setAppState(app, featureState);
    handleWorkspaceChange(app, beforeWorkspace, featureState);

    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("Choose a valid model tier before starting");
  });

  it("does not render a notice after switching machine", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults({
      starterModelPolicyPreference: { mode: "tiered", tier: "advanced" },
    }));
    vi.spyOn(modelTiersApi, "settings")
      .mockResolvedValue(invalidTierCatalog("advanced", "Advanced points to a missing model"));
    vi.spyOn(sessionController(app), "startSession").mockResolvedValue(false);
    stubMachineChangeSideEffects(app);
    setAppState(app, preferenceCapableStarterState());
    await loadStarterSessionDefaults(app, mainWorkspace);
    await flush();
    await startSessionAndOpenChat(app);

    const beforeMachine = appState(app);
    const remoteState: AppState = { ...beforeMachine, selectedMachine: remoteMachine };
    setAppState(app, remoteState);
    handleMachineChange(app, beforeMachine, remoteState);

    expect(starterNotice(app)).toBeUndefined();
    expect(templateText(renderApp(app))).not.toContain("Choose a valid model tier before starting");
  });

  it("does not render a start failure that lands after the user moved to another workspace", async () => {
    const app = createApp();
    vi.spyOn(sessionsApi, "sessionDefaults").mockResolvedValue(starterDefaults());
    const pendingStart = deferred<void>();
    vi.spyOn(sessionController(app), "startSessionWithPrompt").mockReturnValue(pendingStart.promise);
    stubComposerFocus(app);
    stubWorkspaceChangeSideEffects(app);
    setRouteRestoreInProgress(app);
    setAppState(app, starterState());
    await loadStarterSessionDefaults(app, mainWorkspace);

    // The start is still in flight when the user switches workspace, so the
    // rejection publishes a notice scoped to a workspace that is no longer
    // selected. This is the one path where the scope gate is load-bearing on its
    // own: `handleStartSessionPrompt`'s catch has no scope guard of its own.
    startSessionPrompt(app, "explore the repo");
    const mainState = appState(app);
    const featureState: AppState = {
      ...mainState,
      workspaces: [mainWorkspace, featureWorkspace],
      selectedWorkspace: featureWorkspace,
    };
    setAppState(app, featureState);
    handleWorkspaceChange(app, mainState, featureState);

    pendingStart.reject(new Error("start request rejected"));
    await flush();

    expect(appState(app).error).toBe("");
    expect(templateText(renderApp(app))).not.toContain("start request rejected");
  });

  it("still suppresses the start screen for a genuine screen-selection error", () => {
    const app = createApp();
    setAppState(app, { ...starterState(), error: "Sessions could not be loaded." });

    // `shouldShowSessionStartScreen()` is unchanged: an empty workspace whose
    // session list failed to load must not claim to be empty.
    const text = templateText(renderApp(app));
    expect(text).toContain("Sessions could not be loaded.");
    expect(text).not.toContain("What would you like to build?");
  });
});
```

Add this helper beside the other reflective accessors near the bottom of the same file:

```ts
// Lit's own update cycle is unavailable in this node-only runner, so the notice
// retirement hook is driven directly. It is a component lifecycle method, not a
// template internal, so this is a plain reflective call rather than template
// inspection.
function runWillUpdate(app: PiWebUiApp): void {
  const method: unknown = Reflect.get(app, "willUpdate");
  if (typeof method !== "function") throw new Error("PiWebUiApp.willUpdate is not callable");
  Reflect.apply(method, app, []);
}
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

Expected: FAIL. "retires the notice when an external repair removes the block" fails because `runWillUpdate` does not yet clear the notice, and it reports the notice object instead of `undefined`. The other tests in this block pass already, on Task 2's channel; that is expected and is what Step 6 puts under mutation pressure.

Record which of the new tests passed before the implementation. A test that was already green needs its Step 6 mutation to prove it pins anything.

- [ ] **Step 3: Add the retirement hook**

Extend the existing `./starterNotice` import in `PiWebUiApp.ts` so it reads:

```ts
import { shouldRetainStarterNotice, starterFailureNotice, starterNoticeVisibleText, starterPolicyBlockedNotice, type StarterNotice, type StarterNoticeScope } from "./starterNotice";
```

Add `syncStarterNotice()` immediately after `publishStarterNotice()`:

```ts
  /**
   * Drop a notice the current render would no longer show, rather than leaving it
   * hidden behind a live gate.
   *
   * A `"policy-blocked"` notice then means strictly "the user's last Start attempt
   * was refused", so a later external repair-and-rebreak cannot make a stale
   * refusal reappear without a fresh attempt. This runs in `willUpdate()` because
   * the live `blockedReason` also changes from catalog loads and scope changes the
   * notice itself never observes.
   */
  private syncStarterNotice(): void {
    const notice = this.starterNotice;
    if (notice === undefined) return;
    if (shouldRetainStarterNotice(notice, this.starterNoticeScope(), this.starterModelPolicyInputs()?.status.blockedReason)) return;
    this.starterNotice = undefined;
  }
```

Call it from `willUpdate()`, after the existing warning-visibility sync:

```ts
  protected override willUpdate(): void {
    this.toggleAttribute("pwa-display-mode", this.appShell.isPwaDisplayMode);
    this.syncSessionWarningVisibility();
    this.syncStarterNotice();
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts src/client/src/components/PiWebUiApp.onboarding.test.ts src/client/src/components/starterNotice.test.ts`

Expected: PASS, all files.

- [ ] **Step 5: Prove the live-read property is falsifiable**

This is the mutation the task exists for. In `renderStarterNotice()`, make the notice serve a captured string instead of the live reason:

```ts
  private renderStarterNotice() {
    const notice = this.starterNotice;
    if (notice === undefined) return null;
    const text = notice.message ?? "Choose a valid model tier before starting";
    return html`<p class="starter-notice" role="alert">${text}</p>`;
  }
```

Run: `npm test -- --run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

Expected: FAIL, at least three tests:

- "tracks the live blocked reason instead of a string captured at refusal time" still finds the old text after the catalog explains itself;
- "does not render a notice raised in another workspace or on another machine" renders the leaked notice;
- "does not render a notice after switching machine" renders the leaked notice.

This mutation is deliberately the most plausible wrong implementation: it passes a naive single-render visibility test. If any of those three tests still passes, the assertion is not pinning the live read and must be strengthened before continuing. Revert and confirm green.

- [ ] **Step 6: Prove the retirement and scope gates are falsifiable**

Run these three mutations one at a time, reverting and re-confirming green between each. Record the mutation, the failing test names, and the restored result for every one.

Mutation A, in `syncStarterNotice()` — never retire:

```ts
  private syncStarterNotice(): void {
    return;
  }
```

Expected: FAIL, "retires the notice when an external repair removes the block, with no starter edit" reports the notice instead of `undefined`.

Mutation B, in `shouldRetainStarterNotice` in `starterNotice.ts` — ignore scope:

```ts
export function shouldRetainStarterNotice(
  notice: StarterNotice,
  currentScope: StarterNoticeScope | undefined,
  liveBlockedReason: string | undefined,
): boolean {
  if (notice.kind !== "policy-blocked") return true;
  return liveBlockedReason !== undefined && liveBlockedReason !== "";
}
```

Expected: FAIL in `starterNotice.test.ts` ("drops any notice that no longer matches the selected machine and workspace"). ESLint will also flag `currentScope` as unused; that is fine for a temporary mutation, but confirm the test failure and not just the lint error.

Mutation C, in `starterNoticeVisibleText` in `starterNotice.ts` — ignore scope by dropping the `!inScope(...)` half of the guard:

```ts
  if (notice === undefined) return undefined;
```

Expected: FAIL in `starterNotice.test.ts` ("shows nothing outside the notice's own machine and workspace") and in `PiWebUiApp.sessionModelPolicy.test.ts` ("does not render a start failure that lands after the user moved to another workspace").

That second failure is the one that matters, and it is worth understanding why it is the only app-level test that catches this. `handleWorkspaceChange()` and `handleMachineChange()` both clear the notice through `resetStarterModelPolicyForScopeChange()`, so a notice raised *before* a scope change is already gone and the render gate never sees it. Only a rejection that lands *after* the scope change publishes an out-of-scope notice, and `handleStartSessionPrompt`'s catch has no scope guard of its own. If that test still passes under this mutation, the scope gate is untested at the app level and the test must be strengthened before continuing.

- [ ] **Step 7: Verify the whole repository**

Run:

```bash
npx tsc --noEmit
npx eslint src/client/src/components/PiWebUiApp.ts src/client/src/components/starterNotice.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
npx knip
npm run verify
```

Expected: all clean. `npm run verify` is required here rather than deferred: this task changes `willUpdate()`, which runs on every app render.

- [ ] **Step 8: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "fix: read and retire the starter policy block notice live"
```

## Task 4: Document the notice behavior and add the Changeset

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md:247` (the "Validation and recovery" bullet)
- Modify: `docs/config.html:668` (the matching `<li>`)
- Create: `.changeset/starter-notice-channel.md`

**Interfaces:**

- Consumes the completed user-visible behavior from Tasks 1-3: a starter refusal or failure reports itself without unmounting the new-session start screen; the reason appears whether or not a session is selected in the same workspace; a refusal's text follows the current block reason and disappears when the block is repaired; notices do not cross workspace or machine boundaries.
- Produces: one patch Changeset for package `@hyperdreamer/pi-webui`.
- Produces nothing consumed by a later task; this is the final task.

- [ ] **Step 1: Update the canonical Markdown behavior**

The only existing claim that changes is what a block *shows*. Replace the "Validation and recovery" bullet in `docs/config.md` with:

```md
- **Validation and recovery:** A remembered Tiered choice whose current mapping is unavailable remains selected and blocks Start until the user chooses a valid tier, switches to a complete Exact branch, or repairs the ladder. PI WEBUI never substitutes another tier or Exact mode. A refused Start reports its reason without closing the new-session screen, and the reason is shown whether or not a session is currently selected in that workspace. The message follows the current reason and disappears once the block is repaired.
```

Leave every other bullet as it is. The composer controls, Exact fallback, remembered preference, persistence failures, availability, managed state, and starting/persistence claims are all still accurate.

- [ ] **Step 2: Mirror the claim in HTML**

Replace the matching `<li>` in `docs/config.html` with the same claims, preserving the local structure:

```html
                <li><strong>Validation and recovery:</strong> A remembered Tiered choice whose current mapping is unavailable remains selected and blocks Start until the user chooses a valid tier, switches to a complete Exact branch, or repairs the ladder. PI WEBUI never substitutes another tier or Exact mode. A refused Start reports its reason without closing the new-session screen, and the reason is shown whether or not a session is currently selected in that workspace. The message follows the current reason and disappears once the block is repaired.</li>
```

Do not describe internal names such as `StarterNotice`, `starterNotice`, `state.error`, or `.starter-notice`. The reader is a user, not a maintainer.

- [ ] **Step 3: Add the patch Changeset**

Create `.changeset/starter-notice-channel.md` with exactly:

```md
---
"@hyperdreamer/pi-webui": patch
---

Fix the new-session screen closing when a starter action fails. A refused or failed start, and a failed load or save of a workspace's model defaults, now report themselves without unmounting the composer and model controls needed to retry, and a refused start's reason is visible whether or not a session is selected in that workspace.
```

Do not edit `CHANGELOG.md`.

- [ ] **Step 4: Check the docs, the Changeset, and the whole repository**

Run:

```bash
git diff --check
npm run changelog:status
npm run verify
```

Expected: no whitespace errors; Changesets reports the new patch fragment; typecheck, ESLint, Knip, and the full Vitest suite pass.

- [ ] **Step 5: Confirm the Markdown and HTML claims match**

Run:

```bash
diff <(grep -o "A refused Start reports.*repaired\." docs/config.md) <(grep -o "A refused Start reports.*repaired\." docs/config.html)
```

Expected: no output. The two pages must make the same claim word for word; a silent divergence between them is the failure mode this check exists to catch.

- [ ] **Step 6: Commit**

```bash
git add docs/config.md docs/config.html .changeset/starter-notice-channel.md
git commit -m "docs: document the starter notice channel"
```
