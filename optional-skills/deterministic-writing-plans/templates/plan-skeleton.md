# Example Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> deterministic-subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sentence describing what this builds.

**Architecture:** Two or three sentences about the approach.

**Tech Stack:** The key technologies and libraries.

## Global Constraints

- Node 22.19 is the version floor; do not use APIs newer than that.
- No new runtime dependencies.
- Every task's requirements implicitly include this section.

## Task 1: Parser module

**Implementer tier:** Standard

**Files:**

- Create: `src/parse/tokens.ts`
- Test: `src/parse/tokens.test.ts`

**Interfaces:**

- Consumes: nothing; this is the first task.
- Produces: `tokenize(input: string): Token[]`, where
  `Token = { kind: "word" | "space"; text: string }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { tokenize } from "./tokens";

describe("tokenize", () => {
  it("splits a word from trailing space", () => {
    expect(tokenize("hi ")).toEqual([
      { kind: "word", text: "hi" },
      { kind: "space", text: " " },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/parse/tokens.test.ts`
Expected: FAIL, `Cannot find module './tokens'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
export type Token = { kind: "word" | "space"; text: string };

export function tokenize(input: string): Token[] {
  return [...input.matchAll(/\s+|\S+/gu)].map((m) => ({
    kind: /^\s/u.test(m[0]) ? "space" : "word",
    text: m[0],
  }));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/parse/tokens.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/parse/tokens.ts src/parse/tokens.test.ts
git commit -m "feat(parse): tokenize words and spaces"
```

## Task 2: Wire the parser into the CLI

**Implementer tier:** Advanced

**Files:**

- Create: `src/cli/run.ts`
- Modify: `src/cli/index.ts:1-20`
- Test: `src/cli/run.test.ts`

**Interfaces:**

- Consumes: `tokenize(input: string): Token[]` from Task 1, with
  `Token = { kind: "word" | "space"; text: string }`.
- Produces: `runCli(argv: string[]): Promise<number>`, resolving to the
  process exit code.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "./run";

describe("runCli", () => {
  it("returns 0 and counts words", async () => {
    expect(await runCli(["hello world"])).toBe(0);
  });

  it("returns 2 when no argument is given", async () => {
    expect(await runCli([])).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --run src/cli/run.test.ts`
Expected: FAIL, `Cannot find module './run'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
import { tokenize } from "../parse/tokens";

export async function runCli(argv: string[]): Promise<number> {
  const [input] = argv;
  if (input === undefined) return 2;
  const words = tokenize(input).filter((t) => t.kind === "word");
  process.stdout.write(`${String(words.length)}\n`);
  return 0;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --run src/cli/run.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts src/cli/index.ts src/cli/run.test.ts
git commit -m "feat(cli): count words from the first argument"
```
