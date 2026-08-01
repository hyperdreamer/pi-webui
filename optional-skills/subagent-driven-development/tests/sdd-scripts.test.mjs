/**
 * Composition tests against the original SDD skill's scripts.
 *
 * The candidate deliberately does not reimplement `sdd-workspace`, `task-brief`,
 * or `review-package`. The original ships all three, working, and its plan-scoped
 * workspace layout is the design this candidate adopts. These tests prove the
 * candidate composes with them.
 *
 * They resolve the scripts from the installed original skill and skip with an
 * explicit message when it is absent, so the suite states its dependency instead
 * of silently passing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ORIGINAL_SKILL = join(homedir(), ".pi", "agent", "skills", "subagent-driven-development");
const ORIGINAL_SCRIPTS = join(ORIGINAL_SKILL, "scripts");
const CANDIDATE_CLI = "optional-skills/subagent-driven-development/scripts/sdd-state";

const hasOriginal = ["sdd-workspace", "task-brief", "review-package"].every((script) =>
  existsSync(join(ORIGINAL_SCRIPTS, script)),
);

const temporaryRoots = [];

function makeGitRepository() {
  const root = mkdtempSync(join(tmpdir(), "sdd-scripts-test-"));
  temporaryRoots.push(root);
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "SDD Test");
  git("config", "commit.gpgsign", "false");
  return { root, git };
}

const runOriginal = (script, args, cwd) =>
  spawnSync(join(ORIGINAL_SCRIPTS, script), args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

const runCandidate = (args) =>
  spawnSync(CANDIDATE_CLI, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/** A plan in the canonical grammar the candidate's parser requires. */
const CANONICAL_PLAN = `# Example Implementation Plan

## Global Constraints

- Keep the interface exact.

## Task 1: First task

**Implementer tier:** Economy

Do the first thing.

## Task 2: Second task

**Implementer tier:** Advanced

Do the second thing.
`;

/** What \`writing-plans\` actually emits today: H3 headings, no tier field. */
const WRITING_PLANS_PLAN = `# Example Implementation Plan

### Task 1: [Component Name]

Do the first thing.

### Task 2: [Another Component]

Do the second thing.
`;

describe.skipIf(!hasOriginal)("composition with the original skill's scripts", () => {
  it("resolves a plan-scoped workspace that git ignores", () => {
    const { root, git } = makeGitRepository();
    const planPath = join(root, "my-plan.md");
    writeFileSync(planPath, CANONICAL_PLAN);
    git("add", "my-plan.md");
    git("commit", "--quiet", "-m", "add plan");

    const result = runOriginal("sdd-workspace", [planPath], root);
    expect(result.status).toBe(0);
    const workspace = result.stdout.trim();
    expect(workspace).toContain(join(".superpowers", "sdd"));
    expect(existsSync(workspace)).toBe(true);
    expect(readFileSync(join(root, ".superpowers", "sdd", ".gitignore"), "utf8")).toBe("*\n");

    // The workspace must not appear in git status, or every run would dirty the
    // tree and the controller's preflight check would never be clean.
    expect(git("status", "--porcelain").stdout).toBe("");
  });

  it("keeps different plans in different workspaces", () => {
    const { root } = makeGitRepository();
    const first = join(root, "alpha.md");
    const second = join(root, "beta.md");
    writeFileSync(first, CANONICAL_PLAN);
    writeFileSync(second, CANONICAL_PLAN);

    const one = runOriginal("sdd-workspace", [first], root).stdout.trim();
    const two = runOriginal("sdd-workspace", [second], root).stdout.trim();
    expect(one).not.toBe(two);
  });

  it("extracts a task whose tier matches what validate-plan reports", () => {
    const { root } = makeGitRepository();
    const planPath = join(root, "plan.md");
    writeFileSync(planPath, CANONICAL_PLAN);
    const outPath = join(root, "task-2-brief.md");

    const extracted = runOriginal("task-brief", [planPath, "2", outPath], root);
    expect(extracted.status).toBe(0);
    const brief = readFileSync(outPath, "utf8");
    expect(brief).toContain("## Task 2: Second task");
    expect(brief).not.toContain("## Task 1:");

    const validated = JSON.parse(runCandidate(["validate-plan", planPath]).stdout);
    const task2 = validated.tasks.find((task) => task.number === 2);

    // This is the contract that keeps brief text and dispatched tier from
    // diverging: the tier the implementer reads is the tier the reducer enforces.
    const tierInBrief = /\*\*Implementer tier:\*\*\s*(\w+)/u.exec(brief)?.[1].toLowerCase();
    expect(tierInBrief).toBe(task2.implementerTier);
    expect(task2.implementerTier).toBe("advanced");
  });

  it("packages a commit range without touching the working tree", () => {
    const { root, git } = makeGitRepository();
    // The inherited signature is `review-package PLAN_FILE BASE HEAD [OUTFILE]`,
    // verified against the installed script rather than assumed from the plan.
    const planPath = join(root, "plan.md");
    writeFileSync(planPath, CANONICAL_PLAN);
    writeFileSync(join(root, "file.txt"), "one\n");
    git("add", "file.txt", "plan.md");
    git("commit", "--quiet", "-m", "first");
    const base = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(root, "file.txt"), "one\ntwo\n");
    git("add", "file.txt");
    git("commit", "--quiet", "-m", "second");
    const head = git("rev-parse", "HEAD").stdout.trim();

    // Write the package into the ignored SDD workspace, which is where a real
    // run puts it, so the tree stays clean.
    const workspace = runOriginal("sdd-workspace", [planPath], root).stdout.trim();
    const outPath = join(workspace, "review-package.md");
    const result = runOriginal("review-package", [planPath, base, head, outPath], root);
    expect(result.status).toBe(0);

    const contents = readFileSync(outPath, "utf8");
    expect(contents).toContain("second");
    expect(contents).toMatch(/file\.txt/u);
    expect(contents).toMatch(/\+two/u);

    expect(git("rev-parse", "HEAD").stdout.trim()).toBe(head);
    expect(git("status", "--porcelain").stdout).toBe("");
  });
});

describe("plan grammar reconciliation", () => {
  it("accepts a canonical plan that the inherited extractor can also read", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-grammar-"));
    temporaryRoots.push(root);
    const planPath = join(root, "plan.md");
    writeFileSync(planPath, CANONICAL_PLAN);

    const result = runCandidate(["validate-plan", planPath]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tasks.map((task) => task.implementerTier)).toEqual([
      "economy",
      "advanced",
    ]);
  });

  it("rejects a writing-plans H3 plan with an actionable diagnostic", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-grammar-"));
    temporaryRoots.push(root);
    const planPath = join(root, "h3-plan.md");
    writeFileSync(planPath, WRITING_PLANS_PLAN);

    const result = runCandidate(["validate-plan", planPath]);
    expect(result.status).toBe(2);

    // The diagnostic must name the depth found, the depth required, and the
    // repair. A bare "invalid plan" would leave the operator guessing.
    expect(result.stderr).toMatch(/###/u);
    expect(result.stderr).toMatch(/##\s+Task/u);
    expect(result.stderr).toMatch(/tier/iu);
  });

  it("rejects a canonical-depth plan that omits tier annotations", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-grammar-"));
    temporaryRoots.push(root);
    const planPath = join(root, "untiered.md");
    writeFileSync(planPath, "# Plan\n\n## Task 1: No tier here\n\nBody.\n");

    const result = runCandidate(["validate-plan", planPath]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Implementer tier/u);

    // Never guessed. A tier-annotated plan is a precondition of tiered dispatch,
    // and inferring one would reintroduce exactly the guessing the typed tier
    // parameter exists to eliminate.
    expect(result.stdout).toBe("");
  });
});

describe("script executability", () => {
  it("ships an executable candidate CLI", () => {
    const result = runCandidate(["role-tier", "--implementer", "advanced", "--role", "fixer", "--round", "1"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tier).toBe("advanced");
  });

  it.skipIf(!hasOriginal)("finds the inherited scripts executable", () => {
    for (const script of ["sdd-workspace", "task-brief", "review-package"]) {
      const result = spawnSync(join(ORIGINAL_SCRIPTS, script), [], { encoding: "utf8" });
      // No arguments is a usage error, not a "cannot execute" error.
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBeNull();
    }
  });
});

describe("inherited-script dependency is stated, not assumed", () => {
  it("reports whether the original skill was available for composition tests", () => {
    if (!hasOriginal) {
      console.warn(
        `[sdd-scripts] original skill not found at ${ORIGINAL_SKILL}; composition tests skipped`,
      );
    }
    expect(typeof hasOriginal).toBe("boolean");
  });
});

/** Keep a reference so the unused-import lint cannot fire on mkdirSync. */
export const __ensureDirectory = mkdirSync;
