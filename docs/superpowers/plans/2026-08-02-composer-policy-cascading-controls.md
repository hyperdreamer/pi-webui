# Composer Policy Cascading Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session model policy popover with three cascading composer
controls: a two-item mode menu on the pill, a mode-dependent second control (tier
menu in Tiered, the existing searchable model picker in Exact), and an Exact-only
thinking-level menu filtered to the selected model.

**Architecture:** `SessionModelPolicyControl` keeps its trigger pill and
diagnostic chip but loses its panel, becoming a pill plus an anchored mode menu
built on the existing `actionMenu` helpers. A new `SessionTierMenu` renders the
tier list. `PromptEditor` swaps its model and thinking buttons for policy-aware
ones when a policy is present, and `PiWebUiApp` forks the four pick handlers on
the `sessions.modelPolicy` capability so an Exact selection is applied atomically
through `setModelPolicy` instead of the legacy direct writes.

**Tech Stack:** TypeScript, Lit 3 (reactive properties, shadow DOM), Vitest with
jsdom.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-composer-policy-cascading-controls-design.md`. Read it before starting; it records the load-bearing rulings.
- No silent model, tier, or thinking-level substitution or clamping anywhere. An incomplete tuple must yield `undefined` from `sessionModelPolicyUpdateFromDraft`, never a guessed value.
- Retain and reuse `isDraftReadyToApply` and `seedModelPolicyDraft` in `src/client/src/components/sessionModelPolicyDraft.ts` exactly as they are. Do not modify that module; its tests are mutation-verified.
- Never put a backtick inside a Lit ``css`` template literal. It terminates the template and produces an oxc `PARSE_ERROR`. This has already broken this project twice.
- Pure decisions belong in pure modules. Lit components are thin glue: no policy decisions inside render methods.
- Do not add runtime dependencies. Do not add request timeouts to `src/client/src/api/http.ts`; that is a separate tracked follow-up.
- Do not modify `src/server/**`. This slice is client-only.
- Anchored menus must reuse `actionMenuPanelStyle(target, options)` and `isClickWithinActionMenu(event, renderRoot)` from `src/client/src/components/actionMenu.ts`. `MachineSwitcher.ts` is the closest precedent for a pill that opens an anchored menu; read it before writing a new one.
- Run focused tests with `npx vitest run <path>`. Run the full suite with `HOME=$(mktemp -d) npm run verify`; the single `src/server/terminals/terminalService.test.ts` PTY timeout under the real `HOME` is environmental, and Knip's eight configuration hints are pre-existing.
- The pre-commit hook may fail on an unrelated Knip finding about `runtimeFilePaths` in `optional-skills/.../manifest.mjs`. That belongs to another session's uncommitted work in this shared repository. If it blocks a commit, use `--no-verify` after your own focused tests, typecheck, and lint pass, and say so in the report.
- Other sessions work in this repository. Never run `git rebase`, `git stash`, `git reset --hard`, `git clean`, or any history-rewriting or working-tree-discarding command. Commit only files your task owns; unrelated modified files in `git status` are not yours.
- Commit after each task with a Conventional Commits subject under 70 characters.
- Do not add a Changeset in any task except the final documentation task, which owns the single release note.

## Task 1: Retire the policy panel, keep the pill and chip

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts`
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Interfaces:**

- Consumes: `ClientSessionModelPolicyStatus` from `src/shared/apiTypes.ts`, with fields `mode: "exact" | "tiered"`, `tier?: ModelTier`, `resolved: ExactModelSelection`, `ladderValid: boolean`, `blockedReason?: string`.
- Produces: a reduced `SessionModelPolicyControl` that renders only the trigger pill and the diagnostic chip. Retains public properties `status`, `catalog`, `loading`, `saving`, `editable`, `error`. Removes `response`, `onOpen`, `onClose`, `onSave`.
- Produces: exported `TIER_LABELS: Record<ModelTier, string>` and `describeSelection(selection: ExactModelSelection): string`, moved out of this file into a new `src/client/src/components/modelPolicyLabels.ts` so later tasks can import them without importing the component.

This task is deletion plus one extraction. Do not add the mode menu yet; Task 2 does that.

Delete from the component: `renderPanel`, `renderUnavailable`, `renderForm`, `renderTierField`, `renderTierResolution`, `renderExactFields`, `renderDiagnostics`, `draftForResponse`, the `draft` state, `open` state, `toggle`, `close`, `handleKeydown`, `focusPanel`, `changeMode`, `changeTier`, `changeExactModel`, `changeExactThinking`, `applyIfReady`, `scheduleApply`, `cancelPendingApply`, `EXACT_APPLY_DELAY_MS`, and every `.policy-panel*`, `.policy-field`, `.policy-actions`, `.policy-save`, `.policy-cancel`, `.policy-unavailable`, `.policy-retry`, `.policy-blocked`, `.policy-row-error`, `.policy-hint`, `.policy-current`, `.policy-resolution-row` CSS rule, plus the `@media (max-width: 760px)` sheet block.

Keep: the trigger pill and its `aria-label`, `title`, `.policy-mode`, `.policy-tier`, `.policy-resolution` spans, `compactDiagnostic`, `blockedReason`, `effectiveStatus`, and the `.policy-trigger`, `.policy-mode`, `.policy-tier`, `.policy-resolution`, `.policy-diagnostic` CSS rules. The chip already renders as a sibling of the trigger, not inside the panel, so it survives unchanged.

The trigger's click handler becomes a no-op placeholder for this task: keep the button, drop the `@click`. Task 2 restores interaction.

Delete every test in `SessionModelPolicyControl.test.ts` that mounts the panel, opens it, or asserts on panel internals. Keep and adapt the closed-trigger, diagnostic-chip, and status-projection tests. Expect the file to shrink substantially; that is correct.

- [ ] **Step 1: Extract the shared labels**

Create `src/client/src/components/modelPolicyLabels.ts`:

```ts
import { type ExactModelSelection, type ModelTier, type TierModelRef } from "../../../shared/apiTypes";

export const TIER_LABELS: Record<ModelTier, string> = {
  economy: "Economy",
  fast: "Fast",
  standard: "Standard",
  advanced: "Advanced",
  capable: "Capable",
  frontier: "Frontier",
};

/** Canonical ascending thinking-level order. Levels outside this list sort last, in input order. */
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function describeModel(model: TierModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function describeSelection(selection: ExactModelSelection): string {
  return `${describeModel(selection.model)} · ${selection.thinkingLevel}`;
}

export function modelKey(model: TierModelRef): string {
  return `${model.provider}:${model.id}`;
}
```

Copy the existing bodies of `describeModel`, `describeSelection`, and `modelKey` out of `SessionModelPolicyControl.ts` rather than rewriting them, so the rendered text does not change. Read them first and adapt the code above to match if they differ.

- [ ] **Step 2: Write the failing test**

Add to `src/client/src/components/SessionModelPolicyControl.test.ts`:

```ts
describe("SessionModelPolicyControl after panel retirement", () => {
  it("renders only the trigger and, when blocked, the diagnostic chip", async () => {
    const control = await mountControl((element) => {
      element.status = { ...exactStatus(), blockedReason: "MODEL_POLICY_BLOCKED: unverified tuple" };
    });

    expect(shadowRoot(control).querySelector(".policy-trigger")).not.toBeNull();
    expect(shadowRoot(control).querySelector(".policy-diagnostic")?.getAttribute("title")).toContain("MODEL_POLICY_BLOCKED");
    expect(shadowRoot(control).querySelector(".policy-panel")).toBeNull();
    expect(shadowRoot(control).querySelector("select")).toBeNull();
  });

  it("does not open a panel when the trigger is clicked", async () => {
    const control = await mountControl((element) => { element.status = exactStatus(); });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-panel")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: FAIL. The second test fails because clicking still opens the panel.

- [ ] **Step 4: Perform the deletion**

Apply the deletions and retentions listed above. Update `SessionModelPolicyControl.ts` to import `TIER_LABELS`, `describeSelection`, `describeModel`, and `modelKey` from `./modelPolicyLabels` instead of defining them.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Then: `npx tsc --noEmit`
Expected: tests PASS; typecheck reports errors only in files later tasks own (`PromptEditor.ts`, `PiWebUiApp.ts`) for the removed properties. Fix those by deleting the now-invalid property bindings for `response`, `onOpen`, `onClose`, and `onSave` at their call sites, and by deleting tests that assert on those bindings.

- [ ] **Step 6: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts src/client/src/components/modelPolicyLabels.ts src/client/src/components/PromptEditor.ts src/client/src/components/PiWebUiApp.ts
git commit -m "refactor(client): retire the model policy panel"
```

## Task 2: Two-item mode menu on the pill

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/SessionModelPolicyControl.ts`
- Test: `src/client/src/components/SessionModelPolicyControl.test.ts`

**Interfaces:**

- Consumes: `actionMenuPanelStyle(target: EventTarget | null, options?: { constrainTo?: "host" | "viewport" }): string` and `isClickWithinActionMenu(event: Event, renderRoot: EventTarget): boolean` from `./actionMenu`. `TIER_LABELS` and `describeSelection` from `./modelPolicyLabels` (Task 1).
- Produces: a new public property `onSelectMode?: (mode: "exact" | "tiered") => void` on `SessionModelPolicyControl`, fired when the user picks a mode from the menu. The component owns menu open state and closes on pick, on Escape, and on an outside click.

The menu contains exactly two items and nothing else: `Exact model` and `Tiered`, each with a short hint and a checkmark on the current mode. Do not add tier, model, or thinking controls to this menu.

Read `MachineSwitcher.ts` before writing this. Copy its open/close/keyboard structure rather than inventing one.

- [ ] **Step 1: Write the failing test**

```ts
describe("mode menu", () => {
  it("opens a two-item menu from the trigger", async () => {
    const control = await mountControl((element) => { element.status = exactStatus(); element.editable = true; });

    trigger(control).click();
    await control.updateComplete;

    const items = [...shadowRoot(control).querySelectorAll(".policy-mode-item")];
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.textContent?.trim().split("\n")[0])).toEqual(["Exact model", "Tiered"]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("reports the picked mode and closes", async () => {
    const picked: string[] = [];
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.onSelectMode = (mode) => { picked.push(mode); };
    });
    trigger(control).click();
    await control.updateComplete;

    shadowRoot(control).querySelectorAll<HTMLElement>(".policy-mode-item")[1]?.click();
    await control.updateComplete;

    expect(picked).toEqual(["tiered"]);
    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("closes on Escape without reporting a mode", async () => {
    const picked: string[] = [];
    const control = await mountControl((element) => {
      element.status = exactStatus();
      element.editable = true;
      element.onSelectMode = (mode) => { picked.push(mode); };
    });
    trigger(control).click();
    await control.updateComplete;

    shadowRoot(control).querySelector(".policy-mode-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await control.updateComplete;

    expect(picked).toEqual([]);
    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });

  it("does not open while the control is not editable", async () => {
    const control = await mountControl((element) => { element.status = exactStatus(); element.editable = false; });

    trigger(control).click();
    await control.updateComplete;

    expect(shadowRoot(control).querySelector(".policy-mode-menu")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Expected: FAIL, no `.policy-mode-menu` is rendered.

- [ ] **Step 3: Implement the menu**

Add `@state() private menuOpen = false;` and `@state() private menuStyle = "";`, plus the `onSelectMode` property. Render the menu only when `menuOpen`, positioning it with `actionMenuPanelStyle(target, { constrainTo: "viewport" })` captured from the trigger's `event.currentTarget` on click. Give the container class `policy-mode-menu` and each item class `policy-mode-item` with `role="menuitemradio"` and `aria-checked`. Close on pick, on Escape, and on a document click that fails `isClickWithinActionMenu`. Follow `MachineSwitcher`'s listener add/remove lifecycle so the document listener is removed on disconnect.

Gate opening on the existing `canMutate()`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/client/src/components/SessionModelPolicyControl.test.ts`
Then: `npx tsc --noEmit` and `npx eslint src/client/src/components/SessionModelPolicyControl.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionModelPolicyControl.ts src/client/src/components/SessionModelPolicyControl.test.ts
git commit -m "feat(client): open a two-item model policy mode menu"
```

## Task 3: Tier menu component

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/SessionTierMenu.ts`
- Test: `src/client/src/components/SessionTierMenu.test.ts`

**Interfaces:**

- Consumes: `MODEL_TIERS` (`["economy","fast","standard","advanced","capable","frontier"]`), `ModelTier`, and `ModelTierSettingsResponse` with `{ contractVersion: 1; ladder?: ModelTierLadder; models: ModelTierModelOption[]; rows: Record<ModelTier, ModelTierRowValidation>; valid: boolean; configError?: string }` from `src/shared/apiTypes.ts`. `TIER_LABELS` and `describeSelection` from `./modelPolicyLabels`. `actionMenuPanelStyle` and `isClickWithinActionMenu` from `./actionMenu`.
- Produces: a `<session-tier-menu>` element with properties `catalog?: ModelTierSettingsResponse`, `selectedTier?: ModelTier`, `label: string`, `editable = false`, `onSelectTier?: (tier: ModelTier) => void`. Renders a button showing the current tier and its resolution, opening an anchored menu of all six tiers.

Every tier is listed in `MODEL_TIERS` order. A tier whose `catalog.rows[tier].valid` is false renders with `aria-disabled="true"`, class `tier-item-invalid`, its `rows[tier].reason` inline, and must not call `onSelectTier`. A valid tier shows what it resolves to from `catalog.ladder[tier]` via `describeSelection`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import "./SessionTierMenu";
import { MODEL_TIERS, type ModelTier, type ModelTierSettingsResponse } from "../../../shared/apiTypes";
import { SessionTierMenu } from "./SessionTierMenu";

function catalogFixture(): ModelTierSettingsResponse {
  const model = { provider: "openai", id: "gpt-default" };
  return {
    contractVersion: 1,
    ladder: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, { model, thinkingLevel: "medium" }])) as ModelTierSettingsResponse["ladder"],
    models: [{ model, name: "Default", thinkingLevels: ["low", "medium", "high"] }],
    rows: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, { valid: true }])) as ModelTierSettingsResponse["rows"],
    valid: true,
  };
}

async function mountMenu(configure: (element: SessionTierMenu) => void): Promise<SessionTierMenu> {
  const element = new SessionTierMenu();
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: SessionTierMenu): ShadowRoot {
  const shadow = element.shadowRoot;
  if (shadow === null) throw new Error("no shadow root");
  return shadow;
}

async function open(element: SessionTierMenu): Promise<void> {
  root(element).querySelector<HTMLButtonElement>(".tier-trigger")?.click();
  await element.updateComplete;
}

describe("SessionTierMenu", () => {
  it("lists all six tiers in canonical order with their resolutions", async () => {
    const element = await mountMenu((el) => { el.catalog = catalogFixture(); el.selectedTier = "standard"; el.editable = true; el.label = "Standard"; });
    await open(element);

    const items = [...root(element).querySelectorAll(".tier-item")];
    expect(items).toHaveLength(6);
    expect(items.map((item) => item.getAttribute("data-tier"))).toEqual([...MODEL_TIERS]);
    expect(items[2]?.getAttribute("aria-checked")).toBe("true");
    expect(items[0]?.textContent).toContain("openai/gpt-default · medium");
  });

  it("marks an unconfigured tier unselectable with its reason and refuses to pick it", async () => {
    const catalog = catalogFixture();
    catalog.rows.advanced = { valid: false, reason: "Advanced is not configured" };
    const picked: ModelTier[] = [];
    const element = await mountMenu((el) => { el.catalog = catalog; el.selectedTier = "standard"; el.editable = true; el.label = "Standard"; el.onSelectTier = (tier) => { picked.push(tier); }; });
    await open(element);

    const advanced = root(element).querySelector<HTMLElement>('.tier-item[data-tier="advanced"]');
    expect(advanced?.getAttribute("aria-disabled")).toBe("true");
    expect(advanced?.textContent).toContain("Advanced is not configured");
    advanced?.click();
    await element.updateComplete;
    expect(picked).toEqual([]);
  });

  it("reports a valid tier and closes", async () => {
    const picked: ModelTier[] = [];
    const element = await mountMenu((el) => { el.catalog = catalogFixture(); el.selectedTier = "standard"; el.editable = true; el.label = "Standard"; el.onSelectTier = (tier) => { picked.push(tier); }; });
    await open(element);

    root(element).querySelector<HTMLElement>('.tier-item[data-tier="frontier"]')?.click();
    await element.updateComplete;

    expect(picked).toEqual(["frontier"]);
    expect(root(element).querySelector(".tier-menu")).toBeNull();
  });

  it("does not open when it is not editable", async () => {
    const element = await mountMenu((el) => { el.catalog = catalogFixture(); el.editable = false; el.label = "Standard"; });
    await open(element);
    expect(root(element).querySelector(".tier-menu")).toBeNull();
  });
});
```

Add an `afterEach(() => { document.body.replaceChildren(); })`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/SessionTierMenu.test.ts`
Expected: FAIL, `Cannot find module './SessionTierMenu'`.

- [ ] **Step 3: Implement the component**

Write `SessionTierMenu.ts` as a Lit element registered as `session-tier-menu`, following `MachineSwitcher.ts` for menu lifecycle and `SessionModelPolicyControl.ts` for CSS token style. Give each item `role="menuitemradio"`, `data-tier`, `aria-checked`, and for invalid rows `aria-disabled="true"` plus class `tier-item-invalid`. Guard `onSelectTier` on both `editable` and row validity.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/client/src/components/SessionTierMenu.test.ts`
Then: `npx tsc --noEmit` and `npx eslint src/client/src/components/SessionTierMenu.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/SessionTierMenu.ts src/client/src/components/SessionTierMenu.test.ts
git commit -m "feat(client): add an anchored session tier menu"
```

## Task 4: Thinking-level menu filtered to the selected model

**Implementer tier:** Advanced

**Files:**

- Create: `src/client/src/components/thinkingLevelOptions.ts`
- Create: `src/client/src/components/SessionThinkingMenu.ts`
- Test: `src/client/src/components/thinkingLevelOptions.test.ts`
- Test: `src/client/src/components/SessionThinkingMenu.test.ts`

**Interfaces:**

- Consumes: `THINKING_LEVEL_ORDER` from `./modelPolicyLabels` (Task 1). `actionMenuPanelStyle` and `isClickWithinActionMenu` from `./actionMenu`.
- Produces: pure `thinkingLevelOptions(input: { supported: readonly string[]; all: readonly string[]; selected: string }): ThinkingLevelOption[]` where `ThinkingLevelOption = { level: string; supported: boolean; selected: boolean; description?: string }`, sorted by `THINKING_LEVEL_ORDER` with unknown levels last in input order.
- Produces: a `<session-thinking-menu>` element with properties `options: ThinkingLevelOption[]`, `label: string`, `editable = false`, `onSelectLevel?: (level: string) => void`.

The union of `supported` and `all` is listed, so a level the model does not support is visible but unselectable rather than omitted. `description` comes from the same text as the existing `thinkingDescription` helper: `off` "No reasoning", `minimal` "Very brief reasoning (~1k tokens)", `low` "Light reasoning (~2k tokens)", `medium` "Moderate reasoning (~8k tokens)", `high` "Deep reasoning (~16k tokens)", `xhigh` "Maximum reasoning (~32k tokens)", anything else `undefined`.

- [ ] **Step 1: Write the failing pure test**

```ts
import { describe, expect, it } from "vitest";
import { thinkingLevelOptions } from "./thinkingLevelOptions";

describe("thinkingLevelOptions", () => {
  it("sorts canonically rather than by input order", () => {
    const options = thinkingLevelOptions({ supported: ["high", "off", "medium", "low"], all: [], selected: "medium" });
    expect(options.map((option) => option.level)).toEqual(["off", "low", "medium", "high"]);
  });

  it("includes unsupported levels as unselectable", () => {
    const options = thinkingLevelOptions({ supported: ["off", "low"], all: ["off", "low", "medium", "high"], selected: "off" });
    expect(options.map((option) => [option.level, option.supported])).toEqual([["off", true], ["low", true], ["medium", false], ["high", false]]);
  });

  it("marks the selected level and carries cost descriptions", () => {
    const options = thinkingLevelOptions({ supported: ["off", "low", "medium"], all: [], selected: "low" });
    expect(options.find((option) => option.level === "low")?.selected).toBe(true);
    expect(options.find((option) => option.level === "medium")?.description).toBe("Moderate reasoning (~8k tokens)");
  });

  it("puts unknown levels last, in input order, with no description", () => {
    const options = thinkingLevelOptions({ supported: ["ludicrous", "off", "zzz"], all: [], selected: "off" });
    expect(options.map((option) => option.level)).toEqual(["off", "ludicrous", "zzz"]);
    expect(options.at(-1)?.description).toBeUndefined();
  });

  it("does not duplicate a level present in both lists", () => {
    const options = thinkingLevelOptions({ supported: ["off", "low"], all: ["low", "off"], selected: "off" });
    expect(options.map((option) => option.level)).toEqual(["off", "low"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/client/src/components/thinkingLevelOptions.test.ts`
Expected: FAIL, `Cannot find module './thinkingLevelOptions'`.

- [ ] **Step 3: Implement the pure module**

```ts
import { THINKING_LEVEL_ORDER } from "./modelPolicyLabels";

export interface ThinkingLevelOption {
  level: string;
  supported: boolean;
  selected: boolean;
  description?: string;
}

const DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Maximum reasoning (~32k tokens)",
};

export function thinkingLevelOptions(input: {
  supported: readonly string[];
  all: readonly string[];
  selected: string;
}): ThinkingLevelOption[] {
  const supported = new Set(input.supported);
  const seen = new Set<string>();
  const levels: string[] = [];
  for (const level of [...input.supported, ...input.all]) {
    if (seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  const rank = (level: string): number => {
    const index = THINKING_LEVEL_ORDER.indexOf(level as (typeof THINKING_LEVEL_ORDER)[number]);
    return index === -1 ? THINKING_LEVEL_ORDER.length : index;
  };
  return levels
    .map((level, index) => ({ level, index }))
    .sort((left, right) => {
      const byRank = rank(left.level) - rank(right.level);
      return byRank === 0 ? left.index - right.index : byRank;
    })
    .map(({ level }) => ({
      level,
      supported: supported.has(level),
      selected: level === input.selected,
      ...(DESCRIPTIONS[level] === undefined ? {} : { description: DESCRIPTIONS[level] }),
    }));
}
```

- [ ] **Step 4: Write the failing component test**

```ts
import { describe, expect, it, afterEach } from "vitest";
import "./SessionThinkingMenu";
import { SessionThinkingMenu } from "./SessionThinkingMenu";
import { thinkingLevelOptions } from "./thinkingLevelOptions";

afterEach(() => { document.body.replaceChildren(); });

async function mountMenu(configure: (element: SessionThinkingMenu) => void): Promise<SessionThinkingMenu> {
  const element = new SessionThinkingMenu();
  configure(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function root(element: SessionThinkingMenu): ShadowRoot {
  const shadow = element.shadowRoot;
  if (shadow === null) throw new Error("no shadow root");
  return shadow;
}

describe("SessionThinkingMenu", () => {
  it("renders supported levels as selectable and unsupported ones as disabled", async () => {
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: ["off", "low", "medium"], selected: "low" });
      el.label = "low";
      el.editable = true;
    });
    root(element).querySelector<HTMLButtonElement>(".thinking-trigger")?.click();
    await element.updateComplete;

    const items = [...root(element).querySelectorAll(".thinking-item")];
    expect(items.map((item) => item.getAttribute("data-level"))).toEqual(["off", "low", "medium"]);
    expect(items[2]?.getAttribute("aria-disabled")).toBe("true");
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
    expect(items[2]?.textContent).toContain("unsupported");
  });

  it("reports a supported level and refuses an unsupported one", async () => {
    const picked: string[] = [];
    const element = await mountMenu((el) => {
      el.options = thinkingLevelOptions({ supported: ["off", "low"], all: ["off", "low", "medium"], selected: "low" });
      el.label = "low";
      el.editable = true;
      el.onSelectLevel = (level) => { picked.push(level); };
    });
    root(element).querySelector<HTMLButtonElement>(".thinking-trigger")?.click();
    await element.updateComplete;

    root(element).querySelector<HTMLElement>('.thinking-item[data-level="medium"]')?.click();
    await element.updateComplete;
    expect(picked).toEqual([]);

    root(element).querySelector<HTMLElement>('.thinking-item[data-level="off"]')?.click();
    await element.updateComplete;
    expect(picked).toEqual(["off"]);
  });
});
```

- [ ] **Step 5: Run it, confirm it fails, then implement the component**

Run: `npx vitest run src/client/src/components/SessionThinkingMenu.test.ts`
Expected first: FAIL, `Cannot find module './SessionThinkingMenu'`.

Implement `SessionThinkingMenu.ts` as `<session-thinking-menu>`, same menu lifecycle as Task 3. Each item gets `role="menuitemradio"`, `data-level`, `aria-checked`, and for unsupported levels `aria-disabled="true"` plus the visible text `unsupported by this model`. Guard `onSelectLevel` on both `editable` and `option.supported`.

- [ ] **Step 6: Run all four suites and confirm they pass**

Run: `npx vitest run src/client/src/components/thinkingLevelOptions.test.ts src/client/src/components/SessionThinkingMenu.test.ts`
Then: `npx tsc --noEmit` and `npx eslint` on the four new files.
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/src/components/thinkingLevelOptions.ts src/client/src/components/thinkingLevelOptions.test.ts src/client/src/components/SessionThinkingMenu.ts src/client/src/components/SessionThinkingMenu.test.ts
git commit -m "feat(client): add a model-aware thinking level menu"
```

## Task 5: Compose the three controls in the composer row

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PromptEditor.ts:195-230`
- Test: `src/client/src/components/PromptEditor.sessionConfiguration.test.ts`

**Interfaces:**

- Consumes: `SessionModelPolicyControl` with `onSelectMode?: (mode: "exact" | "tiered") => void` (Task 2); `<session-tier-menu>` with `catalog`, `selectedTier`, `label`, `editable`, `onSelectTier?: (tier: ModelTier) => void` (Task 3); `<session-thinking-menu>` with `options`, `label`, `editable`, `onSelectLevel?: (level: string) => void` (Task 4); `thinkingLevelOptions(input)` and `ThinkingLevelOption` (Task 4); `TIER_LABELS`, `describeSelection` (Task 1).
- Produces: new `PromptEditor` properties `onSelectPolicyMode?: (mode: "exact" | "tiered") => void`, `onSelectPolicyTier?: (tier: ModelTier) => void`, `onSelectPolicyThinking?: (level: string) => void`, and `policyThinkingOptions: ThinkingLevelOption[] = []`.

Rendering rules in `renderCompactStatus`, where `policyStatus = this.modelPolicyStatus ?? this.status?.modelPolicy`:

- `policyStatus === undefined`: render exactly what is rendered today. Do not change the non-policy path.
- `policyStatus.mode === "tiered"`: render the policy pill, then `<session-tier-menu>`. Render **no** thinking control.
- `policyStatus.mode === "exact"`: render the policy pill, then the existing `.select-model` button, then `<session-thinking-menu>`. The `.select-thinking` gauge button is replaced by the menu.

- [ ] **Step 1: Write the failing test**

```ts
describe("policy cascading controls", () => {
  it("renders pill, tier menu, and no thinking control in tiered mode", async () => {
    const editor = await mountEditor((element) => {
      element.modelPolicyStatus = { mode: "tiered", tier: "standard", resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" }, ladderValid: true };
      element.modelTierCatalog = catalogFixture();
    });

    expect(shadowRoot(editor).querySelector("session-model-policy-control")).not.toBeNull();
    expect(shadowRoot(editor).querySelector("session-tier-menu")).not.toBeNull();
    expect(shadowRoot(editor).querySelector("session-thinking-menu")).toBeNull();
    expect(shadowRoot(editor).querySelector(".select-thinking")).toBeNull();
  });

  it("renders pill, model button, and thinking menu in exact mode", async () => {
    const editor = await mountEditor((element) => {
      element.modelPolicyStatus = { mode: "exact", resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" }, ladderValid: true };
      element.modelTierCatalog = catalogFixture();
      element.policyThinkingOptions = thinkingLevelOptions({ supported: ["low", "medium", "high"], all: [], selected: "medium" });
    });

    expect(shadowRoot(editor).querySelector("session-tier-menu")).toBeNull();
    expect(shadowRoot(editor).querySelector(".select-model")).not.toBeNull();
    expect(shadowRoot(editor).querySelector("session-thinking-menu")).not.toBeNull();
  });

  it("leaves the legacy controls untouched when there is no policy", async () => {
    const editor = await mountEditor((element) => { element.status = statusFixture(); });

    expect(shadowRoot(editor).querySelector("session-model-policy-control")).toBeNull();
    expect(shadowRoot(editor).querySelector(".select-model")).not.toBeNull();
    expect(shadowRoot(editor).querySelector(".select-thinking")).not.toBeNull();
  });

  it("forwards each control's selection to its callback", async () => {
    const modes: string[] = [];
    const tiers: string[] = [];
    const editor = await mountEditor((element) => {
      element.modelPolicyStatus = { mode: "tiered", tier: "standard", resolved: { model: { provider: "openai", id: "gpt-default" }, thinkingLevel: "medium" }, ladderValid: true };
      element.modelTierCatalog = catalogFixture();
      element.onSelectPolicyMode = (mode) => { modes.push(mode); };
      element.onSelectPolicyTier = (tier) => { tiers.push(tier); };
    });

    const pill = shadowRoot(editor).querySelector("session-model-policy-control");
    const tierMenu = shadowRoot(editor).querySelector("session-tier-menu");
    (pill as unknown as { onSelectMode?: (mode: string) => void }).onSelectMode?.("exact");
    (tierMenu as unknown as { onSelectTier?: (tier: string) => void }).onSelectTier?.("frontier");

    expect(modes).toEqual(["exact"]);
    expect(tiers).toEqual(["frontier"]);
  });
});
```

Reuse the file's existing editor mount helper and status fixtures; read the file first and adapt these names to what it already defines rather than adding duplicates.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/PromptEditor.sessionConfiguration.test.ts`
Expected: FAIL, no `session-tier-menu` or `session-thinking-menu` is rendered.

- [ ] **Step 3: Implement the composition**

Add the four new properties, import the two new components for their side effects, and rewrite the policy branch of `renderCompactStatus` per the rules above. Keep the non-policy branch byte-identical in behavior.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/client/src/components/PromptEditor.sessionConfiguration.test.ts`
Then: `npx tsc --noEmit` and `npx eslint src/client/src/components/PromptEditor.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PromptEditor.ts src/client/src/components/PromptEditor.sessionConfiguration.test.ts
git commit -m "feat(client): compose cascading policy controls in the composer"
```

## Task 6: Fork the pick handlers on the policy capability

**Implementer tier:** Capable

**Files:**

- Modify: `src/client/src/components/PiWebUiApp.ts`
- Test: `src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`

**Interfaces:**

- Consumes: `PromptEditor`'s `onSelectPolicyMode`, `onSelectPolicyTier`, `onSelectPolicyThinking`, `policyThinkingOptions` (Task 5); `thinkingLevelOptions(input)` (Task 4); `seedModelPolicyDraft(input)`, `isDraftReadyToApply(draft, catalog)`, `sessionModelPolicyUpdateFromDraft(draft, catalog)`, `selectDraftExact(draft)`, `selectDraftTier(draft, tier)`, `updateDraftExactModel(draft, option)`, `updateDraftExactThinking(draft, level)` from `./sessionModelPolicyDraft`; existing `sessionModelPolicySupported(machineId?)`, `sessions.saveModelPolicy(update)`, `sessions.setModel(provider, modelId)`, `sessions.setThinkingLevel(level)`, `updateStarterSessionDefaults(update)`, `linkStarterExactBranch(defaults)`.
- Produces: no new exports. Wires the three new `PromptEditor` callbacks for both the active-session and starter composers, and forks the existing pick paths.

This is the load-bearing task. `pickModel` and `pickThinking` currently call `sessions.setModel` / `sessions.setThinkingLevel`, which reach the API directly and bypass the policy layer entirely. On a policy-capable session an Exact selection must instead go through the policy write, so the tuple is applied atomically and persisted as a policy entry. Four paths fork: active model, active thinking, starter model, starter thinking.

Application timing, from the spec:

- A tier selection applies immediately.
- An Exact selection applies only once the model and a supported thinking level are both set, coalesced behind a trailing delay. Reuse `isDraftReadyToApply` as the gate; never submit a partial tuple.
- A pending coalesced apply survives one menu closing before another opens, and is cancelled on a mode change and on disconnect.
- Switching mode must not rewrite the other mode's remembered selection: route mode changes through `selectDraftExact` / `selectDraftTier` on a single draft object.

- [ ] **Step 1: Write the failing test**

```ts
describe("policy-aware pick handlers", () => {
  it("routes an exact model and level through the policy write when the capability is present", async () => {
    const app = policyCapableApp();
    const saved: SessionModelPolicyUpdate[] = [];
    stubSaveModelPolicy(app, (update) => { saved.push(update); });
    const setModel = stubSetModel(app);

    await selectPolicyModel(app, "openai", "gpt-repair");
    expect(saved).toEqual([]);
    await selectPolicyThinking(app, "low");
    await flushCoalescedApply(app);

    expect(setModel).not.toHaveBeenCalled();
    expect(saved).toEqual([{ mode: "exact", exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "low" } }]);
  });

  it("uses the legacy direct write when the capability is absent", async () => {
    const app = legacyApp();
    const saved: SessionModelPolicyUpdate[] = [];
    stubSaveModelPolicy(app, (update) => { saved.push(update); });
    const setModel = stubSetModel(app);

    await selectLegacyModel(app, "openai", "gpt-repair");

    expect(saved).toEqual([]);
    expect(setModel).toHaveBeenCalledWith("openai", "gpt-repair");
  });

  it("applies a tier immediately", async () => {
    const app = policyCapableApp();
    const saved: SessionModelPolicyUpdate[] = [];
    stubSaveModelPolicy(app, (update) => { saved.push(update); });

    await selectPolicyTier(app, "frontier");

    expect(saved).toEqual([{ mode: "tiered", tier: "frontier" }]);
  });

  it("preserves the remembered exact pair across a mode round trip", async () => {
    const app = policyCapableApp();
    const saved: SessionModelPolicyUpdate[] = [];
    stubSaveModelPolicy(app, (update) => { saved.push(update); });

    await selectPolicyModel(app, "openai", "gpt-repair");
    await selectPolicyThinking(app, "low");
    await flushCoalescedApply(app);
    saved.length = 0;

    await selectPolicyMode(app, "tiered");
    await selectPolicyMode(app, "exact");
    await flushCoalescedApply(app);

    expect(saved.at(-1)).toEqual({ mode: "exact", exact: { model: { provider: "openai", id: "gpt-repair" }, thinkingLevel: "low" } });
  });

  it("routes a starter exact selection through the starter defaults path", async () => {
    const app = policyCapableStarterApp();
    const updates: SessionDefaultsUpdate[] = [];
    stubUpdateStarterDefaults(app, (update) => { updates.push(update); });

    await selectStarterPolicyModel(app, "openai", "gpt-repair");
    await selectStarterPolicyThinking(app, "low");

    expect(updates).toHaveLength(2);
  });
});
```

Build the helpers from what this file already provides: `createApp()`, `setAppState(app, state)`, `starterState()`, `activeState(overrides?)`, `starterDefaults(overrides?)`, `validCatalog()`, `machineRuntime(capabilities)`, `activeStatus(policy)`, `exactPolicyStatus()`, and `PI_WEBUI_CAPABILITIES.sessionsModelPolicy`. Read the file before writing helpers, and reuse rather than duplicating. Reach private members with `Reflect.get` / `Reflect.set` as the file already does, and throw if a `Reflect.set` returns false.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Expected: FAIL, the policy-capable exact selection still reaches `setModel`.

- [ ] **Step 3: Implement the fork**

Hold one policy draft per composer, seeded with `seedModelPolicyDraft`. Update it with the draft module's helpers on each selection, then apply when `isDraftReadyToApply` holds: immediately for a tier, coalesced for Exact. Fork on `sessionModelPolicySupported()`; when it is false keep the existing direct writes untouched.

Compute `policyThinkingOptions` with `thinkingLevelOptions`, passing the selected model's `thinkingLevels` from the catalog as `supported` and the session's available levels as `all`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts`
Then: `npx tsc --noEmit` and `npx eslint src/client/src/components/PiWebUiApp.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/src/components/PiWebUiApp.ts src/client/src/components/PiWebUiApp.sessionModelPolicy.test.ts
git commit -m "feat(client): route exact policy picks through the policy write"
```

## Task 7: Documentation, changeset, and full verification

**Implementer tier:** Standard

**Files:**

- Modify: `docs/config.md`
- Modify: `docs/config.html`
- Create: `.changeset/composer-policy-cascading-controls.md`

**Interfaces:**

- Consumes: the behavior delivered by Tasks 1-6. No code changes in this task.
- Produces: no exports.

`docs/config.md` and `docs/config.html` must be updated together and describe the same behavior; the repository treats drift between them as a defect.

- [ ] **Step 1: Update both config documents**

Find the session model policy section in each. Replace any description of a panel, its selects, or a Save button with the cascading controls: the mode pill opens a two-item menu; in Tiered mode the second control is a tier menu that applies immediately and there is no thinking control; in Exact mode the second control is the searchable model picker and the third is a thinking-level menu listing only the levels the selected model supports. State that an exact change applies once both halves are set, that a machine with no configured model shows the controls unset with an explanation, and that a failed tier-settings fetch does not block sending.

Mirror the same content in `docs/config.html`, matching its surrounding markup style.

- [ ] **Step 2: Verify the two documents agree**

Run: `diff <(grep -io "mode menu\|tier menu\|thinking level\|applies immediately\|searchable" docs/config.md | sort -u) <(grep -io "mode menu\|tier menu\|thinking level\|applies immediately\|searchable" docs/config.html | sort -u)`
Expected: no output.

- [ ] **Step 3: Add the changeset**

Write to `.changeset/composer-policy-cascading-controls.md`:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Session model policy is now three cascading composer controls instead of a
popover form. The mode pill offers Exact or Tiered; Tiered picks a tier and
applies at once; Exact opens the searchable model picker and a thinking-level
menu limited to the levels that model supports. A machine with no configured
model shows the controls unset with an explanation instead of hiding them.
```

- [ ] **Step 4: Run full verification**

Run: `HOME=$(mktemp -d) npm run verify`
Expected: exit 0. Typecheck and ESLint clean; Knip reports only its pre-existing configuration hints.

- [ ] **Step 5: Commit**

```bash
git add docs/config.md docs/config.html .changeset/composer-policy-cascading-controls.md
git commit -m "docs(config): document cascading policy controls"
```
