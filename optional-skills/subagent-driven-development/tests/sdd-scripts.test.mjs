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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Prompt rendering.
 *
 * Expectations are composed from the template files plus the supplied context, so
 * the assertion is derived from inputs rather than copied from renderer output. A
 * test that pastes in what the renderer produced can only detect change, not
 * incorrectness.
 */
const SKILL_ROOT = join(import.meta.dirname, "..");
const templateFor = (role) => readFileSync(join(SKILL_ROOT, "prompts", `${role}.md`), "utf8");

function makeRunRoot() {
  const root = mkdtempSync(join(tmpdir(), "sdd-render-"));
  temporaryRoots.push(root);
  const worktree = join(root, "wt");
  const runRoot = join(worktree, ".superpowers", "sdd", "plan-abc12345");
  mkdirSync(runRoot, { recursive: true });
  return { root, worktree, runRoot };
}

const baseContext = (runRoot, worktree) => ({
  worktree,
  runRoot,
  task: 2,
  briefPath: join(runRoot, "task-2-brief.md"),
  reportPath: join(runRoot, "task-2-report.md"),
});

function render(args) {
  return spawnSync(CANDIDATE_CLI, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function renderRole({ role, tier, context, runRoot, name = "context.json" }) {
  const contextPath = join(runRoot, name);
  writeFileSync(contextPath, JSON.stringify(context));
  const outputPath = join(runRoot, `${role}-prompt.md`);
  const result = render([
    "render-prompt",
    "--tier",
    tier,
    "--role",
    role,
    "--context",
    contextPath,
    "--output",
    outputPath,
  ]);
  return { result, outputPath, contextPath };
}

/** Compose the exact bytes the renderer must produce. */
function expectedPrompt({ tier, role, context }) {
  const lines = [
    `/tier-${tier}`,
    "",
    templateFor(role).trimEnd(),
    "",
    "## Dispatch Context",
    "",
    `- worktree: ${context.worktree}`,
    `- runRoot: ${context.runRoot}`,
    `- task: ${String(context.task)}`,
    `- briefPath: ${context.briefPath}`,
    `- reportPath: ${context.reportPath}`,
    "",
    "## Return Channel",
    "",
    `Write exactly one report at ${context.reportPath}.`,
    "Return exactly one status token defined by your role contract above.",
    "",
  ];
  return lines.join("\n");
}

describe("prompt rendering", () => {
  it("renders the implementer prompt byte for byte", () => {
    const { runRoot, worktree } = makeRunRoot();
    const context = baseContext(runRoot, worktree);
    const { result, outputPath } = renderRole({
      role: "implementer",
      tier: "advanced",
      context,
      runRoot,
    });
    expect(result.status).toBe(0);

    const rendered = readFileSync(outputPath, "utf8");
    expect(rendered).toBe(expectedPrompt({ tier: "advanced", role: "implementer", context }));

    // Properties the exact comparison must keep implying.
    expect(rendered.startsWith("/tier-advanced\n")).toBe(true);
    expect(rendered).not.toContain("{{");
  });

  it("puts exactly one blank line between the directive and the contract", () => {
    const { runRoot, worktree } = makeRunRoot();
    const { result, outputPath } = renderRole({
      role: "implementer",
      tier: "economy",
      context: baseContext(runRoot, worktree),
      runRoot,
    });
    expect(result.status).toBe(0);

    // The newline count is part of the contract: an intent stores these bytes and
    // a reissue sends them verbatim, so drift here changes what a child receives.
    const rendered = readFileSync(outputPath, "utf8");
    expect(rendered.split("\n").slice(0, 3)).toEqual(["/tier-economy", "", "# Implementer"]);
  });

  it("renders every tier", () => {
    for (const tier of ["economy", "fast", "standard", "advanced", "capable", "frontier"]) {
      const { runRoot, worktree } = makeRunRoot();
      const { result, outputPath } = renderRole({
        role: "implementer",
        tier,
        context: baseContext(runRoot, worktree),
        runRoot,
      });
      expect(result.status).toBe(0);
      expect(readFileSync(outputPath, "utf8").startsWith(`/tier-${tier}\n`)).toBe(true);
    }
  });

  it("renders every role from its own template", () => {
    for (const role of ["implementer", "task-reviewer", "re-reviewer", "final-reviewer"]) {
      const { runRoot, worktree } = makeRunRoot();
      const context = baseContext(runRoot, worktree);
      const { result, outputPath } = renderRole({ role, tier: "frontier", context, runRoot });
      expect(result.status).toBe(0);
      const rendered = readFileSync(outputPath, "utf8");
      expect(rendered).toBe(expectedPrompt({ tier: "frontier", role, context }));
    }
  });

  it("emits fields in a fixed order regardless of context key order", () => {
    const { runRoot, worktree } = makeRunRoot();
    const base = baseContext(runRoot, worktree);

    // Two contexts with identical content but opposite insertion order. Object
    // key order would leak into the output if emission were not explicitly
    // ordered, and byte-exact dispatch cannot depend on how a JSON file was typed.
    const forward = {
      worktree: base.worktree,
      runRoot: base.runRoot,
      task: base.task,
      baseSha: "a".repeat(40),
      briefPath: base.briefPath,
      reportPath: base.reportPath,
    };
    const reversed = {
      reportPath: base.reportPath,
      briefPath: base.briefPath,
      baseSha: "a".repeat(40),
      task: base.task,
      runRoot: base.runRoot,
      worktree: base.worktree,
    };

    const first = renderRole({
      role: "implementer",
      tier: "advanced",
      context: forward,
      runRoot,
      name: "forward.json",
    });
    const second = renderRole({
      role: "implementer",
      tier: "advanced",
      context: reversed,
      runRoot,
      name: "reversed.json",
    });
    expect(first.result.status).toBe(0);
    expect(second.result.status).toBe(0);
    expect(readFileSync(second.outputPath, "utf8")).toBe(readFileSync(first.outputPath, "utf8"));

    // And the order is the documented one, not merely consistent.
    // Scope to the Dispatch Context block: the role contract body contains its
    // own "- " bullets, which are not context fields.
    const body = readFileSync(first.outputPath, "utf8");
    const section = body.slice(
      body.indexOf("## Dispatch Context"),
      body.indexOf("## Return Channel"),
    );
    const keys = section
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":")));
    expect(keys).toEqual(["worktree", "runRoot", "task", "baseSha", "briefPath", "reportPath"]);
  });

  it("is deterministic across working directory and repeated runs", () => {
    const { runRoot, worktree } = makeRunRoot();
    const context = baseContext(runRoot, worktree);
    const first = renderRole({ role: "implementer", tier: "capable", context, runRoot });
    const firstBytes = readFileSync(first.outputPath);

    const second = spawnSync(
      process.execPath,
      [
        join(SKILL_ROOT, "scripts", "sdd-state.mjs"),
        "render-prompt",
        "--tier",
        "capable",
        "--role",
        "implementer",
        "--context",
        first.contextPath,
        "--output",
        first.outputPath,
      ],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    expect(second.status).toBe(0);
    expect(readFileSync(first.outputPath)).toEqual(firstBytes);
  });

  it("rejects an unknown role or tier", () => {
    const { runRoot, worktree } = makeRunRoot();
    const context = baseContext(runRoot, worktree);
    expect(renderRole({ role: "implementer", tier: "Advanced", context, runRoot }).result.status).toBe(2);
    expect(renderRole({ role: "architect", tier: "advanced", context, runRoot }).result.status).toBe(2);
  });

  it("rejects a missing required path and an unexpected key", () => {
    const { runRoot, worktree } = makeRunRoot();
    const { briefPath, ...withoutBrief } = baseContext(runRoot, worktree);
    expect(briefPath).toBeTruthy();
    const missing = renderRole({
      role: "implementer",
      tier: "advanced",
      context: withoutBrief,
      runRoot,
    });
    expect(missing.result.status).toBe(2);
    expect(missing.result.stderr).toMatch(/briefPath/u);

    const extra = renderRole({
      role: "implementer",
      tier: "advanced",
      context: { ...baseContext(runRoot, worktree), sneaky: "value" },
      runRoot,
      name: "extra.json",
    });
    expect(extra.result.status).toBe(2);
    expect(extra.result.stderr).toMatch(/sneaky|unexpected/u);
  });

  it("rejects a relative path and control characters", () => {
    const { runRoot, worktree } = makeRunRoot();
    for (const [label, field, value] of [
      ["relative", "briefPath", "relative/brief.md"],
      ["nul byte", "reportPath", `${join(runRoot, "report")}\u0000.md`],
      // A literal unnormalized string. join() would collapse the ".." itself,
      // producing a path that is legitimately inside the root and testing nothing.
      ["parent traversal", "briefPath", `${runRoot}/../escaped.md`],
    ]) {
      const result = renderRole({
        role: "implementer",
        tier: "advanced",
        context: { ...baseContext(runRoot, worktree), [field]: value },
        runRoot,
        name: `ctx-${label.replace(/\s/gu, "-")}.json`,
      }).result;
      expect(result.status, label).toBe(2);
    }
  });

  it("rejects a real, existing file that sits outside the pinned roots", () => {
    const { root, runRoot, worktree } = makeRunRoot();
    // The file must actually exist, and its parent must exist too. Otherwise the
    // not-found and missing-parent checks reject it first and the confinement
    // guard is never exercised -- which is exactly what an earlier version of
    // this test did, letting a mutation that deleted the guard pass.
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const escaped = join(outside, "brief.md");
    writeFileSync(escaped, "outside the run\n");
    expect(existsSync(escaped)).toBe(true);

    const result = renderRole({
      role: "implementer",
      tier: "advanced",
      context: { ...baseContext(runRoot, worktree), briefPath: escaped },
      runRoot,
    }).result;
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/beneath a pinned root/u);
  });

  it("rejects a symlink that escapes the run root", () => {
    const { root, runRoot, worktree } = makeRunRoot();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "brief.md"), "escaped\n");
    const link = join(runRoot, "linked-brief.md");
    symlinkSync(join(outside, "brief.md"), link);

    const result = renderRole({
      role: "implementer",
      tier: "advanced",
      context: { ...baseContext(runRoot, worktree), briefPath: link },
      runRoot,
    }).result;
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/escape|real path|symlink/iu);
  });

  it("writes nothing when validation fails", () => {
    const { runRoot, worktree } = makeRunRoot();
    const outputPath = join(runRoot, "implementer-prompt.md");
    renderRole({
      role: "implementer",
      tier: "advanced",
      context: { ...baseContext(runRoot, worktree), briefPath: "relative.md" },
      runRoot,
    });
    expect(existsSync(outputPath)).toBe(false);
  });

  it("enforces the 256-finding bound before size becomes the issue", () => {
    const { runRoot, worktree } = makeRunRoot();
    const atLimit = {
      ...baseContext(runRoot, worktree),
      findingIds: Array.from({ length: 256 }, (_, index) => `F-${String(index)}`),
    };
    expect(
      renderRole({ role: "re-reviewer", tier: "frontier", context: atLimit, runRoot }).result.status,
    ).toBe(0);

    const overLimit = { ...atLimit, findingIds: [...atLimit.findingIds, "F-256"] };
    const result = renderRole({
      role: "re-reviewer",
      tier: "frontier",
      context: overLimit,
      runRoot,
      name: "over.json",
    }).result;
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/256-finding bound/u);
  });

  it("bounds the rendered prompt at 384 KiB", async () => {
    // Reached through the module, because no valid context can produce 384 KiB
    // once findingIds is capped at 256. The bound guards a large role template,
    // which is the only remaining way to exceed it.
    const { renderPrompt } = await import("../scripts/lib/prompt-renderer.mjs");
    const { runRoot, worktree } = makeRunRoot();
    const oversizedRoot = join(runRoot, "oversized-skill");
    mkdirSync(join(oversizedRoot, "prompts"), { recursive: true });
    writeFileSync(join(oversizedRoot, "prompts", "implementer.md"), "x".repeat(384 * 1024 + 1));

    expect(() =>
      renderPrompt({
        tier: "advanced",
        role: "implementer",
        context: baseContext(runRoot, worktree),
        skillRoot: oversizedRoot,
      }),
    ).toThrow(/384 KiB/u);
  });

  it("carries role-specific fields when the role requires them", () => {
    const { runRoot, worktree } = makeRunRoot();
    const context = {
      ...baseContext(runRoot, worktree),
      baseSha: "a".repeat(40),
      headSha: "c".repeat(40),
      findingIds: ["F-1", "F-2"],
    };
    const { result, outputPath } = renderRole({
      role: "re-reviewer",
      tier: "frontier",
      context,
      runRoot,
    });
    expect(result.status).toBe(0);
    const rendered = readFileSync(outputPath, "utf8");
    expect(rendered).toContain(`- baseSha: ${"a".repeat(40)}`);
    expect(rendered).toContain("- findingIds: F-1, F-2");
  });
});
