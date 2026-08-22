# LaTeX Message Rendering Continuation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic subagent-driven-development controller to execute this continuation plan task-by-task.

**Goal:** Complete LaTeX message rendering by independently auditing the committed Task 3 range and verifying the production package, browser behavior, accessibility, nested deployment, and performance contracts.

**Architecture:** Preserve the existing implementation commits and the sealed blocked SDD run. The first task is a read-only audit and fresh review boundary for the exact Task 3 range. The second task runs the remaining unit, build, package, audit, raw Chromium/CDP, nested-deployment, and bounded-render performance checks, with source changes permitted only for a measured browser defect.

**Tech Stack:** TypeScript 6, Marked 18.0.6, KaTeX 0.18.4, Lit 3, Vite 8, Vitest 4, npm 11, raw Chromium CDP, Changesets.

## Global Constraints

- Work in a distinct SDD run rooted in the existing isolated `latex-message-rendering` feature worktree; preserve the blocked run root and never hand-edit its `state.json` or `progress.md`.
- The blocked run's reports, verdicts, prompts, review packages, and findings are provenance only and are not evidence for this continuation.
- The pinned Task 3 source range is exactly `60c87d8760ce7cf64fdf384b933b6c09744ab5d8..9bf12e593d6963124450df7d1a83b59189fb2f04`; do not amend, rebase, recreate, or silently widen it during the read-only audit.
- This is a client-only feature. Do not modify `src/server/sessiond.ts`, session-daemon code or protocol, server routes, prompt transport, session data, persisted configuration, `PromptEditor`, or `ChatView.ts` unless a measured browser defect proves an existing production route is insufficient.
- Keep the direct production dependency `katex: ^0.18.4`, the KaTeX attribution notice, package allowlist, and one minor Changeset; never edit `CHANGELOG.md`.
- Use named KaTeX `renderToString` with exactly `output: "htmlAndMathml"`, `throwOnError: false`, `trust: false`, `strict: "ignore"`, `maxExpand: 1000`, and `maxSize: 100` for accepted formulas.
- Never call `marked.use()` or mutate the shared `marked` singleton. Fresh uncached visual renders own their parser, renderer, and math budget; host speech remains on core Marked behavior.
- Preserve literal/protected-scope fallbacks, sanitizer flow, cache and LRU bounds, code-copy behavior, `LIVE_PLAIN_TEXT_MIN_CHARS = 24_000`, and plain-text composer behavior.
- Live text containing a potential `$`, `\(`, or `\[` opener remains exact line-preserving plain text until settled; settled formatted content uses the existing Markdown boundary.
- KaTeX CSS must remain imported through `katex/dist/katex.min.css?inline` and composed through Lit `unsafeCSS`; `.math-inline` and `.math-display` must contain horizontally without vertical clipping, fixed heights, or maximum heights.
- Use TDD for every production repair: write a focused regression, observe RED, make the smallest fix, observe GREEN, commit only the relevant source and test paths, and repeat the identical failed browser cell.
- Verification fixtures, temporary Vite/CDP files, profiles, logs, screenshots, build output, and result JSON belong under `/tmp` or `src/client/` only while probing and must be removed before completion.
- Every dispatch must render and persist its prompt before spawn, pass the exact stored bytes, correlate the returned session immediately, and compare the child's initial user message with the stored prompt before admitting its report.

## Task 1: Audit The Existing Task 3 Commit Range Without Source Changes

**Implementer tier:** Capable

**Files:**

- Verify: `src/client/src/components/FormattedText.ts`
- Verify: `src/client/src/components/FormattedText.test.ts`
- Verify: `src/client/src/components/ChatView.latex.test.ts`
- Verify: the exact Git range `60c87d8760ce7cf64fdf384b933b6c09744ab5d8..9bf12e593d6963124450df7d1a83b59189fb2f04`
- Do not modify: source files, test files, package metadata, plans, specs, the index, or `HEAD`

**Interfaces:**

- Consumes: the committed Task 3 source range above and the feature's existing formatting and ChatView routing contracts.
- Produces: a bounded implementer report documenting independent source inspection, exact changed-file scope, focused test results, static-check results, and any concrete concern; no deliverable commit.
- Preserves: every byte of the pinned source range and all files outside its three allowed paths.

- [ ] **Step 1: Establish the immutable audit boundary**

Run these commands before source inspection:

```bash
git status --short
git rev-parse 60c87d8760ce7cf64fdf384b933b6c09744ab5d8
git rev-parse 9bf12e593d6963124450df7d1a83b59189fb2f04
git diff --name-status 60c87d8760ce7cf64fdf384b933b6c09744ab5d8..9bf12e593d6963124450df7d1a83b59189fb2f04
git diff --check 60c87d8760ce7cf64fdf384b933b6c09744ab5d8..9bf12e593d6963124450df7d1a83b59189fb2f04
git diff --exit-code -- src/server/sessiond.ts src/client/src/components/ChatView.ts src/client/src/components/PromptEditor.ts
```

Confirm that the exact range contains only `FormattedText.ts`, `FormattedText.test.ts`, and `ChatView.latex.test.ts`; that the current worktree has no uncommitted source changes; and that `ChatView.ts`, `PromptEditor`, server/session-daemon paths, package metadata, and the Changeset were not changed by Task 3.

- [ ] **Step 2: Independently inspect Task 3 behavior**

Read the exact range and verify each contract from source and tests:

- `shouldRenderLivePlainText({ text, live })` is true for every live potential-math opener and for live text at or above `24_000` characters, while settled potential-math text is not forced plain.
- Live updates preserve exact source, line breaks, `.formatted.plain`, and the absence of `.katex`/MathML until `live` becomes false; settlement reaches `toSafeMarkdownHtml()` and produces KaTeX HTML plus MathML.
- `FormattedText.styles` incorporates the Vite inline KaTeX stylesheet through Lit `unsafeCSS`, and the owned `.math-inline`/`.math-display` rules have horizontal containment without vertical clipping, fixed height, or maximum height.
- Existing code-copy behavior and large-tail plain behavior remain covered.
- Existing unchanged `ChatView.renderPart()` routes render user, assistant, thinking, skill, tool-result, queued-server, and streaming content through `formatted-text`, while bash output remains shell/preformatted content.

Do not accept the prior blocked-run reviewer report or implementer report as evidence. Use source and newly run checks only.

- [ ] **Step 3: Run the focused audit verification**

Run:

```bash
npm run test:serial -- --run src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts
npm run typecheck
npx eslint src/client/src/components/FormattedText.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
git diff --check
```

Record the actual pass counts and any existing warnings. If a command fails, determine whether the failure is caused by the pinned range, environment, or an unrelated baseline issue; do not change source to make the audit pass.

- [ ] **Step 4: Write the read-only audit report and stop**

Write the implementer report with:

- the exact base/head SHAs and changed-file list;
- confirmation that no source, test, package, server, composer, or ChatView production file was changed during the audit;
- independently observed behavior and focused test/typecheck/lint results;
- any load-bearing concern stated with a concrete file and line; and
- a `STATUS: DONE` result with no commit because the task is intentionally read-only.

Do not create a commit. The subsequent task-review dispatch must independently review the same pinned range and may not treat this report as sufficient by itself.

## Task 2: Verify Production Assets, Package Contents, Browser Behavior, And Performance

**Implementer tier:** Capable

**Files:**

- Verify: `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `.changeset/latex-message-rendering.md`, `src/client/src/formatting/latexMath.ts`, `src/client/src/formatting/markdown.ts`, `src/client/src/components/FormattedText.ts`, and their focused tests
- Create then remove: `src/client/latex-rendering-probe.html`
- Create then remove: `/tmp/pi-webui-latex-continuation-vite.config.mjs`, `/tmp/pi-webui-latex-continuation-cdp.mjs`, `/tmp/pi-webui-latex-continuation-dist/`, `/tmp/pi-webui-latex-continuation-profile/`, `/tmp/pi-webui-latex-continuation-results.json`, and temporary server logs
- Modify only if a real browser defect is measured: the smallest relevant source file and its focused test file

**Interfaces:**

- Consumes: the existing KaTeX dependency and notice, `FormattedText`, the `base: "./"` Vite contract, the package `files` allowlist, the live/settled rendering boundary, and raw Chromium CDP.
- Produces: independently recorded unit, build, package, audit, production asset, browser, accessibility, nested-deployment, and bounded-render measurements; no temporary artifacts in the final worktree.
- Preserves: the exact Task 3 range unless a measured browser defect requires a narrowly tested repair, with no server, composer, or unrelated source changes.

- [ ] **Step 1: Run deterministic unit, build, package, and audit verification**

Run the focused suite, complete verification, Changeset status, production build, package dry-run, and production-only audit:

```bash
npm run test:serial -- --run scripts/projectIdentity.test.mjs src/client/src/formatting/latexMath.test.ts src/client/src/formatting/markdown.test.ts src/client/src/hostSpeechText.test.ts src/client/src/components/FormattedText.test.ts src/client/src/components/ChatView.latex.test.ts
npm run verify
npm run changelog:status
npm run build
npm pack --dry-run --ignore-scripts --json > /tmp/pi-webui-latex-continuation-pack.json
set +e
npm audit --omit=dev --json > /tmp/pi-webui-latex-continuation-audit.json
audit_status=$?
set -e
node -e 'const report = JSON.parse(require("node:fs").readFileSync("/tmp/pi-webui-latex-continuation-audit.json", "utf8")); if ((report.metadata?.vulnerabilities?.total ?? 0) !== 0) process.exit(1);'
test "$audit_status" -eq 0
```

Parse the package JSON and assert that it includes `package/THIRD_PARTY_NOTICES.md`, emitted KaTeX font assets, and the client bundle. A nonzero production audit or any production/direct dependency vulnerability blocks completion; do not apply the upstream-only `IGNORED.md` exception to a direct or production finding.

- [ ] **Step 2: Create the disposable production fixture and raw-CDP driver**

Create `src/client/latex-rendering-probe.html` temporarily. Import the real `./src/components/FormattedText.ts`, define the required PI color variables, wait for `customElements.whenDefined("formatted-text")`, and mount settled inline, settled display, long display, tall aligned display, and live math elements using these sources:

```ts
const inline = "Inline $x^2 + y_1$";
const display = ["\\[", "\\int_0^1 x^2\\,dx", "\\]"].join("\\n");
const long = `$$${Array.from({ length: 100 }, () => "x").join("+")}$$`;
const tallRows = Array.from({ length: 20 }, (_, i) => `a_${i + 1} &= b_${i + 1}\\\\`);
const tall = ["\\[", "\\begin{aligned}", tallRows.join("\\n"), "\\end{aligned}", "\\]"].join("\\n");
const live = "Streaming $x^2$";
```

Wait for all `updateComplete` promises and two animation frames. Record the live plain state before settling it once, then expose JSON containing viewport width, document/client scroll widths, each math wrapper's client/scroll dimensions and rectangle, MathML count, live-before/live-after state, `document.fonts.check("16px KaTeX_Main")`, and captured page errors.

Create `/tmp/pi-webui-latex-continuation-vite.config.mjs` with `defineConfig`, root at the repository `src/client`, `base: "./"`, a temporary `/tmp/pi-webui-latex-continuation-dist` output directory, and the temporary fixture as the Rollup input. Create `/tmp/pi-webui-latex-continuation-cdp.mjs` using Node's built-in `WebSocket`, a free HTTP port, a free DevTools port, a fresh Chromium user-data directory, a `type: "page"` target, `Page.enable`, `Runtime.enable`, `Network.enable`, `Accessibility.enable`, and `Emulation.setDeviceMetricsOverride` before navigation. Map both `/` and `/nested/` to the same production directory so relative asset URLs are exercised at both prefixes.

- [ ] **Step 3: Execute root and nested acceptance at desktop and mobile sizes**

Run the same production bundle and probe at exactly `1280x800` and `390x844`, first at the root and then at `/nested/latex-rendering-probe.html`. For all four cells, assert from raw CDP measurements:

- `window.innerWidth` equals the requested width.
- Inline and display formulas have nonzero dimensions; settled live math contains `.katex` and MathML; initial live math is plain source without `.katex`.
- `document.scrollWidth <= document.documentElement.clientWidth`; `.formatted`, `.math-inline`, and `.math-display` stay horizontally contained; the long formula overflows inside its own wrapper rather than widening an ancestor.
- The tall aligned formula is not clipped: the wrapper has no fixed/max height, its visible rectangle covers its scroll height, and the final row has a nonzero rectangle inside or below the wrapper.
- Required KaTeX font responses return HTTP 200 and `document.fonts.check("16px KaTeX_Main")` is true.
- `Accessibility.getFullAXTree` exposes the generated mathematical content or a MathML-derived accessible node, and `.katex-mathml math` has a nonzero count.
- No page exception, rejected promise, failed fixture assertion, or unexpected 4xx/5xx font request occurs.

Store screenshots and JSON only under `/tmp`. Classify failures before acting. If a shipped browser defect is measured, use the RED/GREEN repair process in the global constraints, commit only its source/test pair, rebuild, and repeat the identical failed cell.

- [ ] **Step 4: Measure settled cache-miss rendering under the bounded budget**

Using the same fresh production bundle and CDP process, render cache-miss messages with unique ordinary suffixes so the production HTML cache cannot satisfy them. Cover nested fractions, 20 aligned rows, a matrix/cases expression, and repeated formulas while staying within the 512-code-unit, 8-formula, and 4,096-total admission limits. After one warm-up run, collect at least 20 `performance.now()` durations for each representative source, then record p95 and maximum under `/tmp/pi-webui-latex-continuation-performance.json`.

Treat this as release evidence rather than a flaky unit-test timing assertion. If an admitted case exceeds the interaction budget, tighten the numeric admission limit through a deterministic RED/GREEN change and repeat the measurement; do not silently relax a limit or omit the result.

- [ ] **Step 5: Clean every verification artifact and report the measured result**

Stop Chromium, the static server, and any Vite process. Remove every temporary fixture, config, driver, production output, profile, result, screenshot, log, and package/audit JSON:

```bash
rm -f src/client/latex-rendering-probe.html /tmp/pi-webui-latex-continuation-vite.config.mjs /tmp/pi-webui-latex-continuation-cdp.mjs /tmp/pi-webui-latex-continuation-results.json /tmp/pi-webui-latex-continuation-pack.json /tmp/pi-webui-latex-continuation-audit.json /tmp/pi-webui-latex-continuation-performance.json
rm -rf /tmp/pi-webui-latex-continuation-dist /tmp/pi-webui-latex-continuation-profile
git status --short
git diff --check
```

Confirm temporary ports no longer listen and the worktree contains no probe artifacts. If no repair was needed, write `STATUS: DONE` without a commit and include every command, audit result, package assertion, browser cell, accessibility result, cleanup check, and performance measurement. If a repair was needed, include its commit SHA and rerun focused tests, `npm run verify`, build/package/audit checks, and the identical browser cell before reporting.

## Completion Boundary

After both tasks receive independent task-review approval, dispatch a fresh Frontier final reviewer across the complete branch from the feature merge base. The final review must verify the original composer and server/session-daemon boundaries, the exact Task 3 source range and any narrowly justified Task 2 repair, shared Marked isolation, literal/protected fallback contracts, KaTeX options and budgets, sanitizer/cache/speech behavior, Changeset and notice packaging, production audit, raw browser evidence, and temporary-artifact cleanup. Complete only with `SPEC: PASS`, `QUALITY: APPROVED`, no open load-bearing findings, serial verification evidence, a clean worktree, and audit status `OK`.
