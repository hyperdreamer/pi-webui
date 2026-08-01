# Action Palette Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the action palette open after running an action, except for actions that explicitly opt into closing it.

**Architecture:** Add an optional `closesActionPalette?: boolean` field to `AppAction` and to the plugin-facing `PluginAction` (declared in two places). A pure helper `closesActionPaletteAfterRun()` reads it. The single palette wiring point in `PiWebUiApp.render()` consults the helper instead of closing unconditionally. Then set the flag on the classified actions.

**Tech Stack:** TypeScript, Lit 3, Vitest. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-01-action-palette-persistence-design.md`. Read it before starting.
- Absence of the field means the palette stays open. Only `closesActionPalette: true` closes it.
- `PluginAction` is declared twice and both copies must stay identical: `src/plugin-api.ts` (published, generates `dist/plugin-api.js` typings via `tsconfig.plugin-api.json`) and `src/client/src/plugins/types.ts` (internal).
- Do not change `ActionPalette.ts` render or `run()` logic. Do not change any `z-index` value or the backdrop `mousedown` handler; nested-dialog layering is explicitly out of scope.
- Follow existing code style: two-space indent, double-quoted strings, no semicolon omission.
- Tests: `npm test -- --run <file>`. Typecheck: `npm run typecheck`. Both must pass before each commit.
- Commit messages use Conventional Commit style.

---

### Task 1: Add the field and the persistence helper

**Files:**
- Modify: `src/client/src/actions.ts`
- Test: `src/client/src/components/ActionPalette.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppAction.closesActionPalette?: boolean` and `closesActionPaletteAfterRun(action: AppAction): boolean`, both exported from `src/client/src/actions.ts`. Tasks 2 through 5 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `src/client/src/components/ActionPalette.test.ts`. The file already has a local `action()` factory at the bottom; reuse it. Add `closesActionPaletteAfterRun` to the existing `import ... from "../actions"` type-only import by splitting it into a value import:

```ts
import { closesActionPaletteAfterRun } from "../actions";
```

```ts
describe("closesActionPaletteAfterRun", () => {
  it("keeps the palette open for actions that do not opt in", () => {
    expect(closesActionPaletteAfterRun(action("refresh", "Refresh Files"))).toBe(false);
  });

  it("closes the palette when the action opts in", () => {
    expect(closesActionPaletteAfterRun(action("focus", "Focus Prompt", { closesActionPalette: true }))).toBe(true);
  });

  it("keeps the palette open when the action opts out explicitly", () => {
    expect(closesActionPaletteAfterRun(action("toggle", "Hide Info Tab", { closesActionPalette: false }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --run src/client/src/components/ActionPalette.test.ts`
Expected: FAIL. `closesActionPaletteAfterRun` is not exported from `../actions`, and `closesActionPalette` is not a known property of `AppAction`.

- [ ] **Step 3: Add the field and helper**

In `src/client/src/actions.ts`, add the field to the `AppAction` interface immediately after `disabledReason`, then add the helper below the interface:

```ts
  /** Close the action palette after this action runs. Defaults to keeping it open. */
  closesActionPalette?: boolean;
  run: () => void | Promise<void>;
}

export function closesActionPaletteAfterRun(action: AppAction): boolean {
  return action.closesActionPalette === true;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -- --run src/client/src/components/ActionPalette.test.ts`
Expected: PASS, 5 tests (2 pre-existing filter tests plus 3 new).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/actions.ts src/client/src/components/ActionPalette.test.ts
git commit -m "feat(actions): add closesActionPalette to AppAction"
```

---

### Task 2: Make the palette honor the flag

**Files:**
- Modify: `src/client/src/components/PiWebUiApp.ts:3134`
- Test: `src/client/src/components/PiWebUiApp.actionPalette.test.ts` (create)

**Interfaces:**
- Consumes: `closesActionPaletteAfterRun` from Task 1.
- Produces: palette persistence behavior. No new exports.

This is the behavioral core of the change. After it, every action keeps the palette open, because no action sets the flag yet. Tasks 3 through 5 restore closing where it belongs.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/components/PiWebUiApp.actionPalette.test.ts`.

Copy the mounting harness from `src/client/src/components/PiWebUiApp.activityRail.focus.test.ts`: the `// @vitest-environment jsdom` pragma on line 1, the `getContext` canvas spy, the dynamic `await import("./PiWebUiApp")`, `mountWithoutAppSideEffects`, `setAppState`, and the `afterEach` cleanup. Do not use TemplateResult handler extraction; a real DOM harness already exists in that sibling file, so per `.agents/skills/testing-guide/SKILL.md` the escape hatch is not warranted here.

The palette lives in `PiWebUiApp`'s own `renderRoot`, and each row is a `<button>` inside `<action-palette>`'s shadow root. Open it by setting state, and read `actionPaletteOpen` back through `Reflect.get(app, "state")`.

```ts
// @vitest-environment jsdom

import { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { AppAction } from "../actions";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { PiWebUiApp } = await import("./PiWebUiApp");
const { ActionPalette } = await import("./ActionPalette");
type PiWebUiAppElement = InstanceType<typeof PiWebUiApp>;
let mountedApp: PiWebUiAppElement | undefined;

afterEach(async () => {
  document.body.replaceChildren();
  await mountedApp?.updateComplete;
  await Promise.resolve();
  mountedApp = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebUiApp action palette persistence", () => {
  it("keeps the palette open after running an action that does not opt out", async () => {
    const { app, ran } = await openPaletteWith([
      { id: "test.persistent", title: "Refresh Files", run: () => { ran.push("test.persistent"); } },
    ]);

    clickPaletteRow(app, "Refresh Files");
    await app.updateComplete;

    expect(ran).toEqual(["test.persistent"]);
    expect(paletteOpen(app)).toBe(true);
    expect(actionPalette(app)).not.toBeNull();
  });

  it("closes the palette after running an action that opts in", async () => {
    const { app, ran } = await openPaletteWith([
      { id: "test.closing", title: "Focus Prompt", closesActionPalette: true, run: () => { ran.push("test.closing"); } },
    ]);

    clickPaletteRow(app, "Focus Prompt");
    await app.updateComplete;

    expect(ran).toEqual(["test.closing"]);
    expect(paletteOpen(app)).toBe(false);
  });
});

async function openPaletteWith(actions: AppAction[]): Promise<{ app: PiWebUiAppElement; ran: string[] }> {
  const ran: string[] = [];
  const app = new PiWebUiApp();
  setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
  vi.spyOn(PiWebUiApp.prototype, "getActions" as never).mockReturnValue(actions as never);
  mountWithoutAppSideEffects(app);
  await app.updateComplete;
  return { app, ran };
}

function mountWithoutAppSideEffects(app: PiWebUiAppElement): void {
  mountedApp = app;
  vi.spyOn(PiWebUiApp.prototype, "connectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.connectedCallback.call(this);
  });
  vi.spyOn(PiWebUiApp.prototype, "disconnectedCallback").mockImplementation(function (this: PiWebUiAppElement): void {
    LitElement.prototype.disconnectedCallback.call(this);
  });
  document.body.append(app);
}

function setAppState(app: PiWebUiAppElement, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebUiApp state");
}

function paletteOpen(app: PiWebUiAppElement): boolean {
  const state: unknown = Reflect.get(app, "state");
  if (typeof state !== "object" || state === null) throw new Error("PiWebUiApp state is unavailable");
  return Reflect.get(state, "actionPaletteOpen") === true;
}

function actionPalette(app: PiWebUiAppElement): InstanceType<typeof ActionPalette> | null {
  const palette = app.renderRoot.querySelector("action-palette");
  return palette instanceof ActionPalette ? palette : null;
}

function clickPaletteRow(app: PiWebUiAppElement, title: string): void {
  const palette = actionPalette(app);
  if (palette === null) throw new Error("Expected the action palette to be rendered");
  const rows = [...(palette.shadowRoot?.querySelectorAll<HTMLButtonElement>(".options button") ?? [])];
  const row = rows.find((candidate) => candidate.textContent?.includes(title) === true);
  if (row === undefined) throw new Error(`Expected a palette row titled ${title}`);
  row.click();
}
```

Adapt freely if the harness needs adjusting — `getActions` is private, so the
`as never` casts above may need a different shape, and if stubbing it proves
awkward you may instead register a test plugin contributing the two actions, as
`registerActivityPlugin` does in the sibling file. What must not change: the test
mounts the real component, clicks a real row, and asserts real
`actionPaletteOpen` state.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/client/src/components/PiWebUiApp.actionPalette.test.ts`
Expected: FAIL on the first case. The current wiring closes the palette for every action, so `paletteOpen(app)` is `false` where the test expects `true`. The second case passes already.

- [ ] **Step 3: Change the wiring**

In `src/client/src/components/PiWebUiApp.ts`, add `closesActionPaletteAfterRun` to the existing import from `../actions` (the file already imports `type AppAction` from there; make it a value import).

Replace the `.onRun` binding on line 3134:

```ts
        ${state.actionPaletteOpen ? html`<action-palette .actions=${this.getActions()} .onRun=${(action: AppAction) => { if (closesActionPaletteAfterRun(action)) this.setState({ actionPaletteOpen: false }); this.runAction(action); }} .onCancel=${() => { this.setState({ actionPaletteOpen: false }); }}></action-palette>` : null}
```

Leave `.actions` and `.onCancel` exactly as they are.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test -- --run src/client/src/components/ActionPalette.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.actionPalette.test.ts
git commit -m "feat(palette): keep action palette open unless the action opts out"
```

---

### Task 3: Classify the app-level actions

**Files:**
- Modify: `src/client/src/components/PiWebUiApp.ts:1968-2060`

**Interfaces:**
- Consumes: `AppAction.closesActionPalette` from Task 1.
- Produces: nothing new.

These are the actions built directly by `PiWebUiApp`, not by the core plugin.

- [ ] **Step 1: Set the flag on the closing app actions**

In `sessionActions()`, add `closesActionPalette: true` to `app.sessions.cleanup` (it opens `session-cleanup-dialog`). Place it after `group`, before the conditional spread:

```ts
        group: "Sessions",
        closesActionPalette: true,
        ...(canCleanup ? {} : { enabled: false, disabledReason: this.sessionCleanupUnavailableMessage() }),
```

In `navigationFocusActions()`, add `closesActionPalette: true` to all four entries, after `group`:

```ts
        group: "Navigation",
        closesActionPalette: true,
        run: () => this.focusNavigationSection("machines"),
```

Repeat for `-projects`, `-workspaces`, and `-sessions`.

Change nothing in `panelLayoutActions()`. All five of its entries stay open by design.

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts
git commit -m "feat(palette): close the palette for focus and cleanup actions"
```

---

### Task 4: Mirror the field onto PluginAction

**Files:**
- Modify: `src/plugin-api.ts:116-132`
- Modify: `src/client/src/plugins/types.ts:131-141`
- Modify: `src/client/src/plugins/registry.ts:75-88`
- Test: `src/client/src/plugins/registry.test.ts`

**Interfaces:**
- Consumes: `AppAction.closesActionPalette` from Task 1.
- Produces: `PluginAction.closesActionPalette?: boolean`, preserved through `PluginRegistry.getActions()` onto the returned `QualifiedPluginAction`. Task 5 relies on this.

`getActions()` builds each qualified action field by field rather than spreading, so without an explicit copy line the flag is silently dropped. That is what the test guards.

- [ ] **Step 1: Write the failing test**

Add to `src/client/src/plugins/registry.test.ts`, inside the existing `describe("PluginRegistry", ...)` block. The file already has the `createContext()` helper used below.

```ts
  it("preserves closesActionPalette through qualification", () => {
    const registry = new PluginRegistry();
    registry.register({
      id: "example",
      plugin: {
        apiVersion: 1,
        name: "Example",
        activate: () => ({
          contributions: {
            actions: [
              { id: "closing", title: "Closing", closesActionPalette: true, run: () => undefined },
              { id: "persistent", title: "Persistent", run: () => undefined },
            ],
          },
        }),
      },
    });

    const actions = registry.getActions(createContext().context);
    expect(actions.find((action) => action.id === "example:closing")?.closesActionPalette).toBe(true);
    expect(actions.find((action) => action.id === "example:persistent")?.closesActionPalette).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/client/src/plugins/registry.test.ts`
Expected: FAIL. `closesActionPalette` is not a known property of the plugin action literal, and the qualified result has no such field.

- [ ] **Step 3: Add the field to both declarations**

In `src/plugin-api.ts`, inside `interface PluginAction`, after `disabledReason`:

```ts
  /** Explain why a disabled action is visible but unavailable. */
  disabledReason?: (context: PluginRuntimeContext) => string | undefined;
  /** Close the action palette after this action runs. Defaults to keeping it open. */
  closesActionPalette?: boolean;
  run: (context: PluginRuntimeContext) => void | Promise<void>;
```

Apply the identical addition to `interface PluginAction` in `src/client/src/plugins/types.ts`.

- [ ] **Step 4: Copy the field during qualification**

In `src/client/src/plugins/registry.ts`, in `getActions()`, add one line to the block of conditional copies, next to the `group` line:

```ts
      if (action.group !== undefined) qualified.group = action.group;
      if (action.closesActionPalette !== undefined) qualified.closesActionPalette = action.closesActionPalette;
```

- [ ] **Step 5: Verify**

Run: `npm test -- --run src/client/src/plugins/registry.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/plugin-api.ts src/client/src/plugins/types.ts src/client/src/plugins/registry.ts src/client/src/plugins/registry.test.ts
git commit -m "feat(plugins): expose closesActionPalette to plugin actions"
```

---

### Task 5: Classify the core plugin actions

**Files:**
- Modify: `src/client/src/plugins/core/actions.ts`
- Test: `src/client/src/plugins/core/actions.test.ts` (create)

**Interfaces:**
- Consumes: `PluginAction.closesActionPalette` from Task 4.
- Produces: nothing new.

The test pins the exact closing set so that adding a core action later forces a deliberate persistence decision instead of silently inheriting the keep-open default.

- [ ] **Step 1: Write the failing test**

Create `src/client/src/plugins/core/actions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createCoreActions } from "./actions";

describe("createCoreActions", () => {
  it("closes the action palette only for focus, reveal, and dialog actions", () => {
    const closing = createCoreActions().filter((action) => action.closesActionPalette === true).map((action) => action.id);

    expect([...closing].sort()).toEqual([
      "auth.login",
      "auth.logout",
      "machine.add",
      "machine.remove",
      "project.add",
      "prompt.focus",
      "session.start",
      "settings.open",
      "theme.select",
      "view.chat",
      "view.files",
      "view.git",
      "view.terminal",
      "workspace.delete",
    ]);
  });

  it("leaves repeatable actions able to run back to back", () => {
    const actions = createCoreActions();
    const persistent = ["actions.show", "machine.refresh", "machine.open", "workspace.refresh-files", "workspace.refresh-git", "workspace.refresh-current", "session.archive", "session.reload", "session.delete", "session.stop", "app.reload-page"];

    for (const id of persistent) {
      expect(actions.find((action) => action.id === id)?.closesActionPalette, id).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/client/src/plugins/core/actions.test.ts`
Expected: FAIL on the first case. The closing list is empty because no core action sets the flag yet.

- [ ] **Step 3: Set the flag on the fourteen closing core actions**

In `src/client/src/plugins/core/actions.ts`, add `closesActionPalette: true` after the `group` line of each of these, leaving every other entry untouched:

`prompt.focus`, `machine.add`, `machine.remove`, `project.add`, `auth.login`, `auth.logout`, `theme.select`, `settings.open`, `view.chat`, `view.files`, `view.git`, `view.terminal`, `session.start`, `workspace.delete`.

For entries that have an `enabled` predicate, the field order is `group`, then `closesActionPalette`, then `enabled`, then `run`. Example for `view.files`:

```ts
    {
      id: "view.files",
      title: "Go to Files",
      shortcut: "mod+2",
      group: "Navigation",
      closesActionPalette: true,
      enabled: hasWorkspace,
      run: (context) => { context.selectMainView("core:workspace.files"); },
    },
```

Do not add the flag to `actions.show`, `machine.refresh`, `machine.open`, `workspace.refresh-files`, `workspace.refresh-git`, `workspace.refresh-current`, `session.archive`, `session.reload`, `session.delete`, `session.stop`, or `app.reload-page`.

- [ ] **Step 4: Verify**

Run: `npm test -- --run src/client/src/plugins/core/actions.test.ts`
Expected: PASS, 2 tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/plugins/core/actions.ts src/client/src/plugins/core/actions.test.ts
git commit -m "feat(palette): classify core action palette persistence"
```

---

### Task 6: Classify the bundled tasks plugin, changeset, and full verification

**Files:**
- Modify: `pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts:14-24`
- Create: `.changeset/action-palette-persistence.md`
- Test: `src/client/src/components/PiWebUiApp.actionPalette.test.ts` (extend Task 2's file)

**Interfaces:**
- Consumes: `PluginAction.closesActionPalette` from Task 4.
- Produces: the shippable change.

`workspace.open-tasks` reveals a workspace panel, the same intent as `view.files`, so it closes. The other two bundled plugin actions stay open: `info:workspace.show-path` uses `window.alert`, which floats above all layering, and `updates:check` is a refresh.

Bundled plugins ship in the published package: `scripts/build-plugins.mjs` builds `pi-webui-plugins/` into `dist/pi-webui-plugins`, and `dist` is in the `files` allowlist.

- [ ] **Step 1: Set the flag on the tasks action**

In `pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts`:

```ts
            group: "Workspace",
            closesActionPalette: true,
            enabled: (context) => context.state.selectedWorkspace !== undefined,
```

Leave `pi-webui-plugins/info/pi-webui-plugin.ts` and `pi-webui-plugins/updates/pi-webui-plugin.ts` unchanged.

- [ ] **Step 2: Write the changeset**

This is user-visible UI behavior, and `pi-webui-plugins/` ships in the published package, so a changeset is required per `.agents/skills/changeset-changelog/SKILL.md`. Create `.changeset/action-palette-persistence.md`:

```md
---
"@hyperdreamer/pi-webui": patch
---

Keep the Actions palette open after running an action, so toggles and refreshes such as Hide Terminal Tab or Refresh Files can be run several times without reopening it. The palette still closes for actions that move keyboard focus, switch the visible view, or open a dialog, and closes as before with the × button or Escape.
```

`patch` matches the repo's convention: recent `CHANGELOG.md` entries record comparable user-visible UI work, including the Terminal and Info tab visibility persistence, under Patch Changes.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

`tsconfig.json` includes `pi-webui-plugins/**/*.ts` and maps `@hyperdreamer/pi-webui/plugin-api` to `./src/plugin-api.ts`, so the bundled plugin typechecks against the source edited in Task 4. No `dist` rebuild is needed for this check.

- [ ] **Step 4: Full verification**

Run: `npm run verify`
Expected: PASS. This change touches shared types and a published API surface, so the narrow-layer checks are not sufficient on their own.

- [ ] **Step 5: Write the behavior test for the persistence consequences**

The spec's Consequences section claims things no earlier task asserts: that a
toggle's row title flips in place while the palette stays open, that the search
query survives a run, and that a dialog action leaves no palette behind. Cover
them by extending `src/client/src/components/PiWebUiApp.actionPalette.test.ts`
from Task 2, reusing its harness.

There is no Playwright or Puppeteer in this repo; jsdom under
`// @vitest-environment jsdom` is the browser environment available, and it is
enough for all three.

Use the app's real actions here rather than stubbing `getActions`, so the
classification from Tasks 3, 5, and this task is what gets exercised. Add:

```ts
  it("flips a layout toggle title in place and preserves the search query", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    const palette = actionPalette(app);
    if (palette === null) throw new Error("Expected the action palette to be rendered");
    const input = palette.shadowRoot?.querySelector<HTMLInputElement>("input");
    if (input === null || input === undefined) throw new Error("Expected the palette search input");
    input.value = "terminal tab";
    input.dispatchEvent(new Event("input"));
    await palette.updateComplete;

    clickPaletteRow(app, "Hide Terminal Tab");
    await app.updateComplete;
    await palette.updateComplete;

    expect(paletteOpen(app)).toBe(true);
    expect(palette.shadowRoot?.querySelector("input")?.value).toBe("terminal tab");
    const titles = [...(palette.shadowRoot?.querySelectorAll(".options button strong") ?? [])].map((node) => node.textContent);
    expect(titles).toContain("Show Terminal Tab");
    expect(titles).not.toContain("Hide Terminal Tab");
  });

  it("leaves no palette mounted when a dialog action opens its dialog", async () => {
    const app = new PiWebUiApp();
    setAppState(app, { ...initialAppState(), actionPaletteOpen: true });
    mountWithoutAppSideEffects(app);
    await app.updateComplete;

    clickPaletteRow(app, "Open Settings");
    await app.updateComplete;

    expect(paletteOpen(app)).toBe(false);
    expect(actionPalette(app)).toBeNull();
    expect(app.renderRoot.querySelector("settings-dialog")).not.toBeNull();
  });
```

If `Open Settings` cannot reach `settings-dialog` in jsdom without more app
wiring than this harness provides, assert only that the palette is closed and
unmounted, and note the omission in your report. Do not stub `settings-dialog`
into existence.

Run: `npm test -- --run src/client/src/components/PiWebUiApp.actionPalette.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Two manual checks that jsdom cannot cover**

jsdom has no layout or paint, so visual layering and real caret placement stay
manual. The UI dev service autoreloads, so no session daemon restart is needed.
Hand these two to your human partner rather than asserting them:

1. `Focus Prompt` closes the palette and the caret lands in the composer.
2. `Open Settings` closes the palette and the settings dialog is fully visible, with no leftover dimming over it.

- [ ] **Step 7: Commit**

```bash
git add pi-webui-plugins/workspace-tasks/pi-webui-plugin.ts .changeset/action-palette-persistence.md src/client/src/components/PiWebUiApp.actionPalette.test.ts
git commit -m "feat(palette): close the palette when opening the tasks panel"
```

---

## Self-Review

**Spec coverage.** Mechanism: field in Task 1, both `PluginAction` copies and the `getActions()` copy line in Task 4, wiring in Task 2, helper in Task 1. Classification: app-level in Task 3, core in Task 5, bundled in Task 6. Consequences: persisted query and in-place title flip asserted in Task 6 Step 5; no-dialog-under-backdrop covered by Task 6 Step 5's settings case for unmounting, with the visual half in Step 6. Testing: helper tests in Task 1, DOM wiring tests in Task 2, catalog test in Task 5, qualification test in Task 4, and the spec's note that disabled rows need no new coverage is honored by not adding any.

**Placeholders.** None. Every code step carries literal content. Task 2 Step 1 and Task 6 Steps 2 and 5 contain judgment calls, each with a stated decision rule and a default, not deferred work.

**Type consistency.** `closesActionPalette?: boolean` is identical in `AppAction`, both `PluginAction` declarations, and inherited by `QualifiedPluginAction extends AppAction`. `closesActionPaletteAfterRun` keeps that name in Tasks 1 and 2. `createCoreActions` matches the existing export. The fourteen IDs in Task 5's assertion match the fourteen listed in its Step 3 and the spec's table; `app.sessions.cleanup` and the four `app.navigation.focus-*` IDs belong to Task 3 and are correctly absent from the core-plugin assertion.
