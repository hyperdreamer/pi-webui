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
import { createHash } from "node:crypto";
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
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import fakeSddTools from "../evals/fake-sdd-tools.mjs";
import { TIERS, roleTier, tierDirective, tierLabel } from "../scripts/lib/plan-policy.mjs";

const ORIGINAL_SKILL = join(homedir(), ".pi", "agent", "skills", "subagent-driven-development");
const ORIGINAL_SCRIPTS = join(ORIGINAL_SKILL, "scripts");
const CANDIDATE_CLI = "optional-skills/deterministic-subagent-driven-development/scripts/sdd-state";

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

/**
 * Ownership and runtime-manifest behavior.
 *
 * The hash is derived here from first principles -- sorted relative path, NUL,
 * file bytes, NUL -- rather than by calling the implementation, so a manifest
 * that agrees with a broken hasher still fails. The test owns the expected
 * algorithm; the implementation has to match it.
 */
describe("runtime ownership manifest", () => {
  const MANIFEST_PATH = join(SKILL_ROOT, "pi-webui-skill.json");
  const ROOT_PACKAGE_JSON = join(SKILL_ROOT, "..", "..", "package.json");

  const readManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  const deriveRuntimeHash = (runtimeFiles) => {
    const hash = createHash("sha256");
    for (const relativePath of [...runtimeFiles].sort()) {
      hash.update(Buffer.from(relativePath, "utf8"));
      hash.update(Buffer.from([0]));
      hash.update(readFileSync(join(SKILL_ROOT, relativePath)));
      hash.update(Buffer.from([0]));
    }
    return hash.digest("hex");
  };

  it("records the canonical name, owner, opt-in distribution, and a semver source version", () => {
    const manifest = readManifest();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.name).toBe("deterministic-subagent-driven-development");
    expect(manifest.sourcePackage.name).toBe("@hyperdreamer/pi-webui");
    expect(manifest.distribution).toBe("opt-in");
    // Recorded version documents which package version produced this tree. It is
    // deliberately not compared against the current root version: that would fail
    // every release bump, and prepublishOnly runs verify, so it would break the
    // release itself until someone regenerated the manifest by hand.
    expect(manifest.sourcePackage.version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
    expect(JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8")).name).toBe(
      manifest.sourcePackage.name,
    );
  });

  it("stores a runtime hash equal to an independently derived digest", () => {
    const manifest = readManifest();
    expect(manifest.runtimeHashAlgorithm).toBe("sha256-path-nul-bytes-v1");
    expect(manifest.runtimeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.runtimeHash).toBe(deriveRuntimeHash(manifest.runtimeFiles));
  });

  it("lists every runtime file, sorted and deduplicated, and all of them exist", () => {
    const { runtimeFiles } = readManifest();
    expect(runtimeFiles).toEqual([...runtimeFiles].sort());
    expect(new Set(runtimeFiles).size).toBe(runtimeFiles.length);
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    for (const relativePath of runtimeFiles) {
      expect(existsSync(join(SKILL_ROOT, relativePath)), relativePath).toBe(true);
    }
  });

  it("excludes evaluation and test files from the runtime tree", () => {
    const { runtimeFiles } = readManifest();
    // Evals and tests are development evidence. Shipping them would put fake
    // capability tools and adversarial prompts into a consumer's skill.
    for (const relativePath of runtimeFiles) {
      expect(relativePath.startsWith("evals/"), relativePath).toBe(false);
      expect(relativePath.startsWith("tests/"), relativePath).toBe(false);
    }
    expect(runtimeFiles).toContain("SKILL.md");
    expect(runtimeFiles).toContain("scripts/lib/manifest.mjs");
  });

  it("keeps every runtime path inside the source directory", () => {
    const { runtimeFiles } = readManifest();
    const sourceRoot = resolve(SKILL_ROOT);
    for (const relativePath of runtimeFiles) {
      expect(isAbsolute(relativePath), relativePath).toBe(false);
      expect(relativePath.split("/"), relativePath).not.toContain("..");
      const resolved = resolve(sourceRoot, relativePath);
      expect(resolved.startsWith(`${sourceRoot}/`), relativePath).toBe(true);
    }
  });

  it("ships the runtime source but not the development evidence", () => {
    // The source is published so `pi-webui install-extra` has something to install
    // from. Activation is still opt-in: nothing loads these skills automatically.
    const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8"));
    const files = rootPackage.files ?? [];
    expect(files).toContain("optional-skills");
    expect(files).toContain("!optional-skills/**/evals");
    expect(files).toContain("!optional-skills/**/tests");
  });

  it("registers no skill for automatic loading", () => {
    // A `pi.skills` entry would activate these for every session. Installation is
    // an explicit, confirmed user action instead.
    const rootPackage = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8"));
    expect(rootPackage.pi?.skills).toBeUndefined();
  });

  it("recomputes and confirms the stored digest through manifest-hash", () => {
    const result = runCandidate(["manifest-hash", "--manifest", MANIFEST_PATH]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(readManifest().runtimeHash);
  });

  it("fails manifest-hash when the stored digest disagrees with the tree", () => {
    // The tampered copy lives beside the real runtime tree. Verification derives
    // its source root from the manifest's own directory, so a copy in a temp
    // directory would fail on missing files instead of the digest -- the right
    // outcome for the wrong reason, which would not test the integrity gate.
    const tampered = join(SKILL_ROOT, "pi-webui-skill.mismatch-fixture.json");
    try {
      writeFileSync(
        tampered,
        `${JSON.stringify({ ...readManifest(), runtimeHash: "0".repeat(64) }, null, 2)}\n`,
      );
      const result = runCandidate(["manifest-hash", "--manifest", tampered]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("runtime hash mismatch");
    } finally {
      rmSync(tampered, { force: true });
    }
  });

  it("fails manifest-hash when a named runtime file is absent", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "sdd-manifest-"));
    temporaryRoots.push(temporaryRoot);
    const orphan = join(temporaryRoot, "pi-webui-skill.json");
    writeFileSync(orphan, `${JSON.stringify(readManifest(), null, 2)}\n`);
    const result = runCandidate(["manifest-hash", "--manifest", orphan]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("runtime file is missing");
  });
});

/**
 * Tier plumbing through the offline fake.
 *
 * Scope: this exercises the *tier channel* — that a requested tier arrives as a
 * typed field, binds the child, resolves to one exact tuple, and is inert in
 * Exact mode. It says nothing about whether the model at a given tier reasons
 * well. Tier resolution is plumbing; coordinator quality is a separate question
 * that only live evaluation can answer.
 *
 * Evidence comes from real side effects the fake produces — the JSONL tool log,
 * the dispatch registry, and the child transcript — never from prose a model
 * emitted. Note the fake's log records name the tool under the key `tool`
 * (verified in evals/fake-sdd-tools.mjs `logCall`), whereas Pi's own event
 * records use `name`; asserting the wrong key would silently match nothing.
 */
describe("tier plumbing through the offline fake", () => {
  const environmentOverrides = [];

  afterEach(() => {
    while (environmentOverrides.length > 0) {
      const [key, value] = environmentOverrides.pop();
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * Register the fake's tools under a scoped environment.
   *
   * The tools read the environment when they execute, not when they register, so
   * the overrides stay in place until the test ends.
   */
  function loadFakeTools(env) {
    for (const [key, value] of Object.entries(env)) {
      environmentOverrides.push([key, process.env[key]]);
      process.env[key] = value;
    }
    const tools = new Map();
    fakeSddTools({
      registerTool: (definition) => { tools.set(definition.name, definition); },
      on: () => undefined,
    });
    return tools;
  }

  const toolText = (result) => String(result?.content?.[0]?.text ?? "");

  /** One fake environment per row, so log sequence numbers cannot cross rows. */
  function makeFakeEnvironment(overrides = {}) {
    const root = mkdtempSync(join(tmpdir(), "sdd-tier-"));
    temporaryRoots.push(root);
    const logPath = join(root, "tool-log.jsonl");
    const registryPath = join(root, "dispatch-registry.json");
    const tools = loadFakeTools({
      SDD_EVAL_READ_ROOTS_JSON: JSON.stringify([root]),
      SDD_EVAL_TOOL_LOG: logPath,
      ...overrides,
    });
    return { root, logPath, registryPath, tools };
  }

  const logRecords = (logPath) =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];

  const registryRecords = (registryPath) =>
    existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")) : {};

  /** Thinking-level ordering, used to check the ladder resolves monotonically. */
  const THINKING_RANK = { low: 0, medium: 1, high: 2, max: 3 };

  /**
   * Every tier paired with a role that would plausibly run at it, so each row
   * renders a real role contract rather than a synthetic prompt. Roles cycle
   * across the four templates; the tier column is the exhaustive part.
   *
   * `implementer` and `formulaRole` name the policy-module inputs whose derived
   * tier must equal the row's tier, which ties the formula, the rendered
   * directive, and the typed field into one chain per row.
   */
  const TIER_ROWS = [
    { tier: "economy", role: "implementer", formulaRole: "implementer", implementer: "economy" },
    { tier: "fast", role: "implementer", formulaRole: "implementer", implementer: "fast" },
    { tier: "standard", role: "task-reviewer", formulaRole: "task-reviewer", implementer: "fast" },
    { tier: "advanced", role: "implementer", formulaRole: "implementer", implementer: "advanced" },
    { tier: "capable", role: "re-reviewer", formulaRole: "re-reviewer", implementer: "advanced" },
    { tier: "frontier", role: "final-reviewer", formulaRole: "final", implementer: "standard" },
  ];

  it("covers the whole frozen ladder exactly once", () => {
    // If a tier is added to the ladder, this table must grow with it, otherwise
    // the six-tier claim below quietly becomes a five-tier claim.
    expect(TIER_ROWS.map((row) => row.tier)).toEqual([...TIERS]);
  });

  it("declares tier as a typed enum parameter, not a prompt convention", () => {
    const { tools } = makeFakeEnvironment();
    const schema = tools.get("spawn_subsession").parameters;
    expect(schema.properties.tier.type).toBe("string");
    expect(schema.properties.tier.enum).toEqual([...TIERS]);
    // The binding channel is a declared parameter. `prompt` is a separate field
    // and carries no tier semantics.
    expect(Object.keys(schema.properties).sort()).toEqual(["cwd", "prompt", "tier"]);
  });

  describe.each(TIER_ROWS)("Tiered mode, $tier via the $role prompt", ({ tier, role, formulaRole, implementer }) => {
    it("binds the typed tier and reports it back through the child transcript", () => {
      // The tier dispatched is the tier the policy formula derives for this role,
      // not a value hand-picked for the test. A formula change that moved a role
      // off this rung fails here rather than silently dispatching the old tier.
      const derived = roleTier({ implementer, role: formulaRole });
      expect(derived.tier).toBe(tier);

      const { runRoot, worktree } = makeRunRoot();
      const context = baseContext(runRoot, worktree);
      const rendered = renderRole({ role, tier, context, runRoot });
      expect(rendered.result.status, rendered.result.stderr).toBe(0);
      const prompt = readFileSync(rendered.outputPath, "utf8");

      // The leading directive is human-readable display text, and it agrees with
      // both the formula and the tier about to be typed.
      expect(prompt.split("\n")[0]).toBe(derived.directive);
      expect(prompt.split("\n")[0]).toBe(`/tier-${tier}`);

      const { logPath, registryPath, tools } = makeFakeEnvironment({
        SDD_EVAL_POLICY_MODE: "tiered",
      });
      const spawned = JSON.parse(toolText(
        tools.get("spawn_subsession").execute("call-1", { prompt, cwd: worktree, tier }),
      ));
      expect(Object.keys(spawned)).toEqual(["sessionId", "cwd"]);

      // 1. The requested tier is a typed field on the recorded spawn call.
      const spawnCalls = logRecords(logPath).filter((record) => record.tool === "spawn_subsession");
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].detail.tier).toBe(tier);
      // Lowercase is the identifier; TitleCase is display only and must never be
      // what crosses the wire.
      expect(spawnCalls[0].detail.tier).toBe(tier.toLowerCase());
      expect(spawnCalls[0].detail.tier).not.toBe(tierLabel(tier));

      // 2. The child was actually created and carries the same lowercase tier.
      expect(registryRecords(registryPath)[spawned.sessionId]).toMatchObject({
        cwd: worktree,
        tier,
      });

      // 3. The effective tier the child reports, and the resolved tuple.
      const transcript = JSON.parse(toolText(
        tools.get("read_subsession").execute("call-2", { sessionId: spawned.sessionId }),
      ));
      expect(transcript.requestedTier).toBe(tier);
      expect(transcript.effectiveTier).toBe(tier);
      expect(transcript.tierOutcome).toBe("applied-tiered");
      // The tuple shape is the contract's ExactModelSelection: model identity
      // plus thinking level, and nothing else.
      expect(Object.keys(transcript.resolved).sort()).toEqual(["model", "thinkingLevel"]);
      expect(Object.keys(transcript.resolved.model).sort()).toEqual(["id", "provider"]);
      expect(transcript.resolved.model.provider).toMatch(/\S/u);
      expect(transcript.resolved.model.id).toMatch(/\S/u);
      expect(THINKING_RANK[transcript.resolved.thinkingLevel]).toBeGreaterThanOrEqual(0);
    });
  });

  it("resolves the six tiers to six distinct, monotonically ordered tuples", () => {
    const { registryPath, tools } = makeFakeEnvironment({ SDD_EVAL_POLICY_MODE: "tiered" });
    const spawn = tools.get("spawn_subsession");
    const readChild = tools.get("read_subsession");

    const resolvedByTier = new Map();
    for (const tier of TIERS) {
      const spawned = JSON.parse(toolText(
        spawn.execute(`call-${tier}`, { prompt: `${tierDirective(tier)}\nWork.`, cwd: "/eval/worktree", tier }),
      ));
      const transcript = JSON.parse(toolText(readChild.execute(`read-${tier}`, { sessionId: spawned.sessionId })));
      expect(transcript.effectiveTier).toBe(tier);
      resolvedByTier.set(tier, transcript.resolved);
    }

    // Six calls, six children: the runtime does not deduplicate, so each request
    // must have produced its own row.
    expect(Object.keys(registryRecords(registryPath))).toHaveLength(TIERS.length);

    // Distinct tuples. If a mutation collapsed two tiers onto one model, a
    // per-tier equality check would still pass while the ladder had lost a rung.
    const fingerprints = TIERS.map((tier) => {
      const tuple = resolvedByTier.get(tier);
      return `${tuple.model.provider}/${tuple.model.id}:${tuple.thinkingLevel}`;
    });
    expect(new Set(fingerprints).size).toBe(TIERS.length);

    // And capability does not go backwards as the ladder ascends.
    const ranks = TIERS.map((tier) => THINKING_RANK[resolvedByTier.get(tier).thinkingLevel]);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(ranks.at(-1)).toBeGreaterThan(ranks[0]);
  });

  it("treats the leading directive as display only, with no binding power", () => {
    const { registryPath, tools } = makeFakeEnvironment({ SDD_EVAL_POLICY_MODE: "tiered" });
    // A prompt that shouts /tier-frontier but types no tier binds nothing. This
    // is the inert-control-channel claim stated as a side effect: the child is
    // recorded with a null tier and never resolves the frontier tuple.
    const spawned = JSON.parse(toolText(
      tools.get("spawn_subsession").execute("call-1", { prompt: "/tier-frontier\nWork.", cwd: "/eval/worktree" }),
    ));
    expect(registryRecords(registryPath)[spawned.sessionId].tier).toBeNull();

    const transcript = JSON.parse(toolText(
      tools.get("read_subsession").execute("call-2", { sessionId: spawned.sessionId }),
    ));
    expect(transcript.requestedTier).toBeNull();
    expect(transcript.effectiveTier).toBeNull();
    expect(transcript.resolved.thinkingLevel).not.toBe("max");
  });

  it("rejects a directive that disagrees with the typed tier, before any child exists", () => {
    const { logPath, registryPath, tools } = makeFakeEnvironment({ SDD_EVAL_POLICY_MODE: "tiered" });
    const spawn = tools.get("spawn_subsession");

    const disagreeing = toolText(
      spawn.execute("call-1", { prompt: "/tier-frontier\nWork.", cwd: "/eval/worktree", tier: "economy" }),
    );
    expect(disagreeing).toContain("disagrees with typed tier");
    // The refusal is only meaningful if nothing was created: a message alone
    // would not prove the spawn failed closed.
    expect(registryRecords(registryPath)).toEqual({});
    // The attempt is still observable, so a controller cannot hide it.
    expect(logRecords(logPath).filter((record) => record.tool === "spawn_subsession")).toHaveLength(1);

    // The agreeing form of the same request succeeds, so the rejection is about
    // disagreement and not about directives in general.
    const agreeing = JSON.parse(toolText(
      spawn.execute("call-2", { prompt: "/tier-economy\nWork.", cwd: "/eval/worktree", tier: "economy" }),
    ));
    expect(registryRecords(registryPath)[agreeing.sessionId].tier).toBe("economy");
  });

  it("refuses a TitleCase tier, because only the lowercase identifier is on the wire", () => {
    const { registryPath, tools } = makeFakeEnvironment({ SDD_EVAL_POLICY_MODE: "tiered" });
    for (const tier of TIERS) {
      const label = tierLabel(tier);
      expect(label).not.toBe(tier);
      expect(toolText(tools.get("spawn_subsession").execute(`call-${tier}`, { prompt: "Work.", tier: label })))
        .toContain("not in the configured ladder");
    }
    expect(registryRecords(registryPath)).toEqual({});
  });

  /**
   * Exact mode. The requested tier is ignored and the pinned runtime tuple is
   * unchanged, so a controller must not report a tier as applied.
   */
  describe.each(["economy", "advanced", "frontier"])("Exact mode ignores tier %s", (tier) => {
    it("leaves the runtime tuple identical and reports ignored-exact", () => {
      const { registryPath, tools } = makeFakeEnvironment({
        SDD_EVAL_POLICY_MODE: "exact",
        SDD_EVAL_LADDER_VALID: "false",
      });
      const policyTool = tools.get("get_model_policy");

      const before = JSON.parse(toolText(policyTool.execute("call-1", {})));
      expect(before.policy.mode).toBe("exact");
      expect(before.policy.currentTier).toBeNull();
      expect(before.tierCommands.exactOutcome).toBe("ignored-exact");
      // Exact mode pins one tuple: what runs now is what the next request runs.
      expect(before.policy.nextRequestResolved).toEqual(before.policy.currentRuntime);
      // The pinned tuple is not free to drift. The Exact-mode eval scenario's
      // prompt narrates the inherited tuple to the controller as
      // RightCode-OpenAI/gpt-5.6-sol at high, so a fake that pins anything else
      // would hand the controller policy evidence contradicting its own briefing
      // and the run would test confusion rather than Exact-mode behavior. The
      // literal is owned here deliberately: deriving it from the fake would make
      // this assertion vacuous.
      expect(before.policy.currentRuntime).toEqual({
        model: { provider: "RightCode-OpenAI", id: "gpt-5.6-sol" },
        thinkingLevel: "high",
      });

      const spawned = JSON.parse(toolText(
        tools.get("spawn_subsession").execute("call-2", {
          prompt: `${tierDirective(tier)}\nWork.`,
          cwd: "/eval/worktree",
          tier,
        }),
      ));
      // The request was accepted and recorded verbatim; it simply did not bind.
      expect(registryRecords(registryPath)[spawned.sessionId].tier).toBe(tier);

      const transcript = JSON.parse(toolText(
        tools.get("read_subsession").execute("call-3", { sessionId: spawned.sessionId }),
      ));
      expect(transcript.requestedTier).toBe(tier);
      expect(transcript.tierOutcome).toBe("ignored-exact");
      expect(transcript.tierOutcome).toBe(before.tierCommands.exactOutcome);
      // No effective tier exists in Exact mode, and the child runs the pinned
      // tuple rather than anything derived from the request.
      expect(transcript.effectiveTier).toBeNull();
      expect(transcript.resolved).toEqual(before.policy.currentRuntime);

      const after = JSON.parse(toolText(policyTool.execute("call-4", {})));
      // Byte-identical, not merely deep-equal on the fields checked above.
      expect(JSON.stringify(after.policy)).toBe(JSON.stringify(before.policy));
      expect(after.policy.currentRuntime).toEqual(before.policy.currentRuntime);
    });
  });

  it("resolves every Exact-mode request to the same tuple across all six tiers", () => {
    const { tools } = makeFakeEnvironment({ SDD_EVAL_POLICY_MODE: "exact" });
    const spawn = tools.get("spawn_subsession");
    const readChild = tools.get("read_subsession");
    const pinned = JSON.parse(toolText(tools.get("get_model_policy").execute("call-0", {})))
      .policy.currentRuntime;

    const tuples = TIERS.map((tier) => {
      const spawned = JSON.parse(toolText(
        spawn.execute(`call-${tier}`, { prompt: `${tierDirective(tier)}\nWork.`, cwd: "/w", tier }),
      ));
      return JSON.parse(toolText(readChild.execute(`read-${tier}`, { sessionId: spawned.sessionId }))).resolved;
    });

    // In Tiered mode these six are distinct. In Exact mode they must collapse to
    // the single pinned tuple, which is what "ignored" means concretely.
    for (const tuple of tuples) expect(tuple).toEqual(pinned);
    expect(new Set(tuples.map((tuple) => JSON.stringify(tuple))).size).toBe(1);
  });
});

describe("CLI entrypoint detection survives symlinked paths", () => {
  // Node resolves symlinks for import.meta.url but leaves process.argv[1] as
  // given, so a literal comparison fails when the skill is invoked through a
  // symlink. The CLI then produces no output and still exits 0, which is how
  // this shipped broken to a skill installed under a symlinked home directory.
  it("produces output when invoked through a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-symlink-"));
    const link = join(root, "linked-skill");
    symlinkSync(SKILL_ROOT, link);

    const viaLink = spawnSync(
      process.execPath,
      [
        join(link, "scripts", "sdd-state.mjs"),
        "manifest-hash",
        "--manifest",
        join(SKILL_ROOT, "pi-webui-skill.json"),
      ],
      { encoding: "utf8" }
    );

    expect(viaLink.status).toBe(0);
    expect(viaLink.stdout.trim()).not.toBe("");
    expect(JSON.parse(viaLink.stdout).verified).toBe(true);
  });
});
