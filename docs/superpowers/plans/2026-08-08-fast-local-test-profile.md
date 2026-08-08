# Fast Local Test Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit four-worker local test command while keeping the serial test profile authoritative for verification and future agent guidance.

**Architecture:** Keep `vitest.config.ts` and the existing `npm test` default unchanged, preserving serial behavior for unqualified and staged validation. Add named package-script profiles so local developers can opt into four workers while `verify` explicitly selects one worker; document the distinction at the contributor and agent guidance surfaces.

**Tech Stack:** npm package scripts, Vitest 4, Markdown documentation, Vitest contract tests.

## Global Constraints

- Keep `vitest.config.ts` at `maxWorkers: 1`; do not change the shared default.
- Add no runtime dependencies and do not edit generated `CHANGELOG.md`.
- `npm run test:fast` must use exactly `--maxWorkers=4`.
- `npm run test:serial` must use exactly `--maxWorkers=1`.
- `npm run verify` must invoke `npm run test:serial` explicitly.
- Use focused tests first, `npm run test:fast` for broad local feedback, and `npm run verify` as the final quality gate.
- Do not run full suites concurrently with other heavy jobs, parallel agents, or subsessions.

## Task 1: Add Explicit Fast And Serial Test Profiles

**Implementer tier:** Standard

**Files:**

- Modify: `scripts/projectIdentity.test.mjs:9-49`
- Modify: `package.json:39-45`
- Modify: `README.md:144-158`
- Modify: `.agents/skills/testing-guide/SKILL.md:78-99`

**Interfaces:**

- Consumes: the existing `packageManifest` object loaded from the repository root's `package.json` in `scripts/projectIdentity.test.mjs`.
- Produces: package scripts with these exact values:
  - `test`: `vitest run --config vitest.config.ts`
  - `test:fast`: `vitest run --config vitest.config.ts --maxWorkers=4`
  - `test:serial`: `vitest run --config vitest.config.ts --maxWorkers=1`
  - `verify`: `npm run typecheck && npm run lint && npm run knip && npm run test:serial`

- [ ] **Step 1: Write the failing contract test**

Add a test to the existing `describe("project identity", ...)` block in `scripts/projectIdentity.test.mjs`:

```js
  it("exposes explicit fast and serial test profiles while keeping verification serial", () => {
    expect(packageManifest.scripts).toMatchObject({
      test: "vitest run --config vitest.config.ts",
      "test:fast": "vitest run --config vitest.config.ts --maxWorkers=4",
      "test:serial": "vitest run --config vitest.config.ts --maxWorkers=1",
      verify: "npm run typecheck && npm run lint && npm run knip && npm run test:serial",
    });
  });
```

- [ ] **Step 2: Run the focused test and confirm the expected failure**

Run:

```bash
npm test -- --run scripts/projectIdentity.test.mjs
```

Expected result before implementation: the existing four tests pass and the new test fails because `packageManifest.scripts` does not yet contain `test:fast` or `test:serial`, with an assertion showing the missing expected values.

- [ ] **Step 3: Add the minimal package-script implementation**

In `package.json`, keep the existing `test` value and add the two named profiles immediately after it. Replace the final `npm test` segment of `verify` with `npm run test:serial`:

```json
    "test": "vitest run --config vitest.config.ts",
    "test:fast": "vitest run --config vitest.config.ts --maxWorkers=4",
    "test:serial": "vitest run --config vitest.config.ts --maxWorkers=1",
    "verify": "npm run typecheck && npm run lint && npm run knip && npm run test:serial",
```

Do not change `vitest.config.ts`.

- [ ] **Step 4: Add contributor and agent guidance**

In the README `Development` section, add this concise paragraph after the development-process commands and before the validation command:

```md
For faster broad local feedback, run `npm run test:fast`. Keep `npm run verify`
for final validation; it uses the serial test profile for reliability.
```

In `.agents/skills/testing-guide/SKILL.md`, add a subsection immediately before `### Resource contention during local full-suite runs`:

```md
### Fast local feedback

- Use focused tests first: `npm test -- --run <test-file>`.
- Use `npm run test:fast` when broad local feedback is useful.
- Do not run `test:fast` alongside another full suite, heavy job, parallel agent, or
  subsession; concurrent load can cause timing-sensitive tests to time out.
- Treat `test:fast` as iterative feedback. Use `npm run verify` as the final gate;
  it runs the serial profile.
```

- [ ] **Step 5: Run focused green verification**

Run:

```bash
npm test -- --run scripts/projectIdentity.test.mjs
```

Expected result: 5 tests pass in the focused file, including the exact script contract. Also run `git diff --check` and confirm it exits successfully.

- [ ] **Step 6: Run the broad fast profile**

Run:

```bash
npm run test:fast
```

Expected result: all discovered test files pass, and the command line shown by npm includes `vitest run --config vitest.config.ts --maxWorkers=4`.

- [ ] **Step 7: Run the authoritative verification gate**

Run:

```bash
npm run verify
```

Expected result: typecheck, lint, Knip, and the full serial test profile all exit successfully; the final npm output shows `npm run test:serial` and Vitest reports all test files passed.

- [ ] **Step 8: Commit the implementation**

```bash
git add package.json scripts/projectIdentity.test.mjs README.md .agents/skills/testing-guide/SKILL.md
git commit -m "test: add fast local test profile"
```

The commit must not include changes to `vitest.config.ts`, `CHANGELOG.md`, or unrelated files.
