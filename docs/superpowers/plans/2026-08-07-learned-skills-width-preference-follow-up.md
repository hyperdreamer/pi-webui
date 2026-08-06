# Learned Skills Width Preference Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the user's learned-skills desktop list-width preference across temporary container clamps and mobile viewport transitions while rendering and announcing the currently effective clamped width.

**Architecture:** Keep two explicit state values inside `PiWebUiLearnedSkillsPanel`: a preferred width representing durable user intent and `listWidth` representing the effective width currently applied to CSS and separator ARIA. Passive rendering and resize observation derive `listWidth` from the unchanged preference; pointer and keyboard input update the preference from the reachable effective width and persist only at the existing interaction boundaries.

**Tech Stack:** TypeScript, custom elements and Shadow DOM, Vitest with jsdom, browser `ResizeObserver` and `localStorage`, Chromium DevTools Protocol.

## Global Constraints

- Work only in `/data/home/guest/Development/pi-webui/.worktrees/learned-skills-plugin` on branch `learned-skills-plugin`; do not modify `main`.
- Prefix every shell command with `source yesconda;`.
- Node `>=22.19.0` is the runtime floor; do not use newer-only APIs.
- Add no runtime dependencies.
- Preserve the strictly read-only Learned Skills feature and all provider, API, polling, Activity Rail, selection, resize, accessibility, and responsive-navigation behavior outside this width-state correction.
- Keep `listWidth` as the currently applied effective width used by CSS and `aria-valuenow`; add a separate private preferred-width state for durable user intent.
- Passive render, `ResizeObserver`, and window-resize paths must never overwrite the preferred width. Pointer and keyboard resize actions may update it, and persistence remains under `pi-webui:workspace-learned-skills:layout:v1`.
- At widths `<=760px`, keep the one-column UI and hidden divider; ignore but retain the desktop preference, then reapply it when the viewport becomes desktop again.
- Follow strict TDD: add both regressions first, run them against `ec8bddfed769085de8926fa688235e2d613b36c9`, and record the expected RED values before editing production code.
- Do not modify `README.md`, `CHANGELOG.md`, `docs/plugins.md`, `docs/plugins.html`, `.changeset/tidy-learned-skills.md`, or `src/server/sessiond.ts`; the existing unreleased patch Changeset already covers the Learned Skills feature.
- Do not retain temporary Chromium fixture, script, profile, screenshot, or log artifacts in tracked files.
- Run full verification only on an otherwise idle machine; do not run any other heavy suite concurrently.

## Task 1: Preserve Preferred Width Across Runtime Layout Clamps

**Implementer tier:** Advanced

**Files:**

- Modify: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.ts:57-265`
- Test: `pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts:173-222`
- Do not retain: temporary Chromium fixture/script/profile/screenshot/log files used for the real-layout probe

**Interfaces:**

- Consumes: `readLearnedSkillsListWidth(): number`, `writeLearnedSkillsListWidth(width: number): void`, and `clampLearnedSkillsListWidth(width: number, containerWidth?: number): number` from `learnedSkillsPanelLayout.ts`.
- Consumes: the existing `ResizeObserver` harness and mutable `getBoundingClientRect()` width fixture in `learnedSkillsPanelElement.test.ts`.
- Produces: private `preferredListWidth: number`, always in the static `190..440` range and changed only by explicit pointer/keyboard resizing.
- Preserves: public `listWidth: number` as the effective width after current container clamping; `--learned-skills-list-width` and separator `aria-valuenow` continue to expose this effective value.

- [ ] **Step 1: Add a failing desktop shrink-expand regression**

Extend the existing `reclamps a persisted width when the host becomes measurable after connection` test or split it into an equally focused test. Start with stored preference `440`, connect while the host reports width `0`, notify at host width `700`, then notify again at host width `900`.

Assert this exact sequence:

```ts
expect(appliedWidth(panel)).toBe("440px");

containerWidth = 700;
resizeObserver.notify();
expect(appliedWidth(panel)).toBe("372px");
expect(separator.getAttribute("aria-valuenow")).toBe("372");
expect(separator.getAttribute("aria-valuemax")).toBe("372");
expect(JSON.parse(requireStoredLayout())).toEqual({ version: 1, listWidth: 440 });

containerWidth = 900;
resizeObserver.notify();
expect(appliedWidth(panel)).toBe("440px");
expect(separator.getAttribute("aria-valuenow")).toBe("440");
expect(separator.getAttribute("aria-valuemax")).toBe("440");
expect(JSON.parse(requireStoredLayout())).toEqual({ version: 1, listWidth: 440 });
```

A tiny local `appliedWidth(panel)` helper is optional; keep it file-local if added.

- [ ] **Step 2: Add a failing desktop-mobile-desktop regression**

Add a separate test with stored preference `440`, the existing `ResizeObserver` harness, mutable host width, and mutable `window.innerWidth`. Exercise:

1. desktop at host width `700`, producing effective `372`;
2. mobile at viewport/host width `390`, where the desktop width is ignored but storage remains `440`;
3. desktop again at viewport `1040` and host width `900`, restoring effective `440`.

After each transition, call the observer harness. Assert that storage remains `{ version: 1, listWidth: 440 }`; after returning to desktop assert CSS width and separator `aria-valuenow`/`aria-valuemax` are `440`. Keep the test independent of jsdom layout: use mutable `window.innerWidth` through the existing `isNarrowViewport()` fallback (or a mutable `matchMedia` stub), and assert the viewport transition does not alter selection/detail state. The real one-column geometry is proved by the Chromium step below.

- [ ] **Step 3: Run both regressions and confirm RED for the root cause**

Run:

```bash
source yesconda; npm test -- --run pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts
```

Expected on `ec8bddf`: both new restoration assertions fail with effective `372px` where `440px` is required. Confirm the failures are behavioral assertions, not setup or environment errors, and record them in the implementer report.

- [ ] **Step 4: Separate preferred state from effective state**

In `PiWebUiLearnedSkillsPanel`, initialize both values from the one storage read:

```ts
private preferredListWidth: number;
public listWidth: number;

constructor() {
  super();
  this.root = this.attachShadow({ mode: "open" });
  this.preferredListWidth = readLearnedSkillsListWidth();
  this.listWidth = this.preferredListWidth;
}
```

Keep the implementation local to this element. Use intention-revealing private operations equivalent to these responsibilities:

```ts
private applyPreferredListWidth(): void {
  this.applyEffectiveListWidth(this.preferredListWidth);
}

private applyEffectiveListWidth(width: number): void {
  const containerWidth = this.isNarrowViewport() ? undefined : this.knownContainerWidth();
  this.listWidth = clampLearnedSkillsListWidth(width, containerWidth);
  this.style.setProperty("--learned-skills-list-width", `${String(this.listWidth)}px`);
  this.updateSeparator();
}

private updatePreferredListWidth(width: number, persist = false): void {
  this.applyEffectiveListWidth(width);
  this.preferredListWidth = this.listWidth;
  if (persist) writeLearnedSkillsListWidth(this.preferredListWidth);
}
```

Equivalent naming is acceptable, but state ownership is not: passive paths must call the operation that applies from `preferredListWidth` without changing it; explicit user-input paths must update the preference from the reachable effective width.

- [ ] **Step 5: Route every width transition through the correct state owner**

Make these ownership rules explicit in the code:

- `handleWindowResize` and `render` reapply `preferredListWidth` passively.
- Pointer-down continues to capture the currently effective `listWidth` as its drag baseline.
- Pointer-move updates the in-tab preferred width from the newly reachable effective width but does not persist yet.
- Pointer-up persists `preferredListWidth`; pointer-cancel and disconnect keep the existing no-persist behavior.
- Keyboard Left/Right/Home/End update and immediately persist `preferredListWidth` from the effective clamped result.
- `updateSeparator` continues to expose effective `listWidth`; `runtimeMaximumWidth()` remains based on current geometry.
- A divider click without movement must not replace a retained larger preference merely because the host is temporarily constrained.

Do not change the storage envelope or `learnedSkillsPanelLayout.ts`.

- [ ] **Step 6: Run focused GREEN verification**

Run:

```bash
source yesconda; npm test -- --run pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts
source yesconda; npx eslint pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.ts pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts
source yesconda; npm run typecheck
```

Expected: all panel tests pass, including the two new regressions; ESLint and typecheck exit successfully.

- [ ] **Step 7: Probe real Chromium shrink-expand and viewport restoration**

Follow the `probe-narrow-lit-layout-with-chromium-cdp` procedure. Use a temporary fixture under `src/client` that imports the real `PluginActivityDialog`, activates the real bundled Learned Skills plugin, supplies a populated Activity Rail context, and waits for custom-element rendering plus two animation frames after every geometry change. Use isolated adjacent API/UI ports if the prior feature server occupies `8818/8819`.

With local storage seeded to `{ "version": 1, "listWidth": 440 }`, require this measured sequence:

1. At Chromium viewport `1040x780`, constrain the real panel host to a measured width of `700px`. Require effective CSS width and separator `aria-valuenow`/`aria-valuemax` of `372`, with storage still `440`.
2. Expand the measured host to `900px` without reconstructing the element. Require effective CSS width and separator values of `440`, with storage still `440`.
3. Use `Emulation.setDeviceMetricsOverride` for exact viewport `390x780`. Require the divider hidden, one-column list/detail navigation retained, no document or panel horizontal overflow, and stored preference still `440`.
4. Return to exact viewport `1040x780` and measured host width `900px`. Require effective CSS width and separator values restored to `440`, storage still `440`, and no document or panel horizontal overflow.

Record actual viewport, host, CSS variable, separator ARIA, storage, document `clientWidth`/`scrollWidth`, panel `clientWidth`/`scrollWidth`, and divider display values in the implementer report. Screenshots may live only under ignored `.superpowers/` or outside the repository.

- [ ] **Step 8: Remove probe artifacts and run full verification**

Stop temporary Chromium and its debugging port, stop temporary feature servers unless intentionally reusing stable existing handles, and remove every temporary fixture, script, profile, screenshot, and log. Then run sequentially on an otherwise idle machine:

```bash
source yesconda; npm run verify
source yesconda; npm run build
source yesconda; git diff --check
source yesconda; git status --short
```

Expected: verification and build pass; only `learnedSkillsPanelElement.ts` and its test remain changed. Confirm `README.md`, `CHANGELOG.md`, docs, the existing Changeset, `learnedSkillsPanelLayout.ts`, and `src/server/sessiond.ts` are unchanged.

- [ ] **Step 9: Commit the follow-up fix**

```bash
source yesconda; git add pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.ts pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts
source yesconda; git commit -m "fix(skills): preserve learned skills width preference"
```

- [ ] **Step 10: Verify the exact committed state**

```bash
source yesconda; npm test -- --run pi-webui-plugins/workspace-learned-skills/learnedSkillsPanelElement.test.ts
source yesconda; git diff --check ec8bddfed769085de8926fa688235e2d613b36c9..HEAD
source yesconda; git status --short
source yesconda; git log --oneline --decorate -5
```

Expected: focused tests pass, the worktree is clean, the follow-up commit is `HEAD`, and the range contains only the plan commit plus the two implementation/test files.
