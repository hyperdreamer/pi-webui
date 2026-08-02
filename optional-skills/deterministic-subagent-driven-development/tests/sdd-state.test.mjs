import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertRuntimeList,
  buildManifest,
  computeRuntimeHash,
  createInitialState,
  dispatchKeyFor,
  fixerTier,
  ManifestError,
  parsePlanText,
  PHASES,
  reduceState,
  reReviewerTier,
  reviewerTier,
  roleTier,
  TERMINAL_PHASES,
  tierDirective,
  tierEcho,
  tierLabel,
  TIERS,
  TRANSITIONS,
  validateState,
} from "../scripts/sdd-state.mjs";

const VALID_PLAN = `# Example Implementation Plan

## Global Constraints

- Keep the interface exact.

## Task 1: Mechanical fixture

**Implementer tier:** Economy

One requirement.

## Task 2: Integrated behavior

**Implementer tier:** Advanced

Another requirement.
`;

describe("deterministic SDD plan contract", () => {
  it("extracts Global Constraints, contiguous tasks, and exact Implementer tiers", () => {
    const parsed = parsePlanText(VALID_PLAN, "/tmp/plan.md");
    expect(parsed.globalConstraints).toContain("Keep the interface exact");
    expect(parsed.tasks).toEqual([
      expect.objectContaining({ number: 1, title: "Mechanical fixture", implementerTier: "economy" }),
      expect.objectContaining({ number: 2, title: "Integrated behavior", implementerTier: "advanced" }),
    ]);
  });

  it("returns null globalConstraints for a valid plan without that section", () => {
    const parsed = parsePlanText(
      "# Plan\n\n## Task 1: Only task\n\n**Implementer tier:** Fast\n\nBody.\n",
      "/tmp/plan.md",
    );
    expect(parsed.globalConstraints).toBeNull();
    expect(parsed.tasks).toHaveLength(1);
  });

  describe("rejects malformed plans", () => {
    const cases = [
      ["numbering not starting at 1", "## Task 2: A\n\n**Implementer tier:** Fast\n"],
      ["a numbering gap", "## Task 1: A\n\n**Implementer tier:** Fast\n\n## Task 3: B\n\n**Implementer tier:** Fast\n"],
      ["a duplicate task number", "## Task 1: A\n\n**Implementer tier:** Fast\n\n## Task 1: B\n\n**Implementer tier:** Fast\n"],
      ["an unknown tier value", "## Task 1: A\n\n**Implementer tier:** Turbo\n"],
      ["a missing tier field", "## Task 1: A\n\nNo tier here.\n"],
      ["a duplicate tier field", "## Task 1: A\n\n**Implementer tier:** Fast\n\n**Implementer tier:** Capable\n"],
      ["no tasks at all", "# Plan\n\n## Global Constraints\n\n- Only constraints.\n"],
      [
        "duplicate Global Constraints",
        "## Global Constraints\n\n- One.\n\n## Global Constraints\n\n- Two.\n\n## Task 1: A\n\n**Implementer tier:** Fast\n",
      ],
      [
        "Global Constraints after the first task",
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n## Global Constraints\n\n- Late.\n",
      ],
      ["an H1 task heading", "# Task 1: A\n\n**Implementer tier:** Fast\n"],
      ["an H3 task heading", "### Task 1: A\n\n**Implementer tier:** Fast\n"],
      ["an H4 task heading", "#### Task 1: A\n\n**Implementer tier:** Fast\n"],
      ["a zero-padded task number", "## Task 01: A\n\n**Implementer tier:** Fast\n"],
      ["a task heading with no colon", "## Task 1 A\n\n**Implementer tier:** Fast\n"],
      ["a task heading with no title", "## Task 1: \n\n**Implementer tier:** Fast\n"],
      ["an indented task heading", " ## Task 1: A\n\n**Implementer tier:** Fast\n"],
      ["a task heading with trailing whitespace", "## Task 1: A \n\n**Implementer tier:** Fast\n"],
      ["a tier field with trailing whitespace", "## Task 1: A\n\n**Implementer tier:** Fast \n"],
      ["an indented tier field", "## Task 1: A\n\n  **Implementer tier:** Fast\n"],
      ["an unterminated backtick fence", "## Task 1: A\n\n**Implementer tier:** Fast\n\n```js\nnever closed\n"],
      ["an unterminated tilde fence", "## Task 1: A\n\n**Implementer tier:** Fast\n\n~~~\nnever closed\n"],
      ["a backtick opener whose info string holds a backtick", "## Task 1: A\n\n**Implementer tier:** Fast\n\n``` ` \n```\n"],
    ];

    for (const [label, plan] of cases) {
      it(`rejects ${label}`, () => {
        expect(() => parsePlanText(plan, "/tmp/plan.md")).toThrow();
      });
    }
  });

  describe("treats fenced content as opaque", () => {
    it("ignores task-like headings and tier fields inside a fence", () => {
      const parsed = parsePlanText(
        [
          "## Task 1: Real",
          "",
          "**Implementer tier:** Fast",
          "",
          "```md",
          "## Task 9: Fake",
          "**Implementer tier:** Frontier",
          "### Task 8: Also fake",
          "```",
          "",
          "Body.",
          "",
        ].join("\n"),
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].implementerTier).toBe("fast");
      expect(parsed.tasks[0].body).toContain("## Task 9: Fake");
    });

    it("keeps a shorter or opposite delimiter as fenced content", () => {
      const parsed = parsePlanText(
        [
          "## Task 1: Real",
          "",
          "**Implementer tier:** Fast",
          "",
          "````",
          "```",
          "~~~",
          "## Task 9: Fake",
          "````",
          "",
        ].join("\n"),
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].body).toContain("## Task 9: Fake");
    });

    it("accepts a tilde opener with arbitrary info text", () => {
      const parsed = parsePlanText(
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n~~~text with ~ and ` chars\n## Task 9: Fake\n~~~\n",
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
    });

    it("permits up to three spaces of fence indentation and closes on a longer run", () => {
      const parsed = parsePlanText(
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n   ```\n## Task 9: Fake\n   `````\n",
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
    });

    it("treats four-space indented code as ordinary content, not a fence", () => {
      const parsed = parsePlanText(
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n    ```\n    not a fence\n\nMore body.\n",
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].body).toContain("not a fence");
    });

    it("rejects a task-like heading that is four-space indented only as content", () => {
      const parsed = parsePlanText(
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n    ## Task 9: Indented\n",
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
    });

    it("does not close a fence when non-whitespace follows the closer", () => {
      const parsed = parsePlanText(
        "## Task 1: A\n\n**Implementer tier:** Fast\n\n```\n``` trailing\n## Task 9: Fake\n```\n",
        "/tmp/plan.md",
      );
      expect(parsed.tasks).toHaveLength(1);
    });
  });

  describe("honors section boundaries at non-canonical headings", () => {
    it("excludes an intervening non-canonical section from globalConstraints", () => {
      const parsed = parsePlanText(
        [
          "## Global Constraints",
          "",
          "- Constraint text.",
          "",
          "## File Map",
          "",
          "- some/path.mjs",
          "",
          "## Task 1: A",
          "",
          "**Implementer tier:** Fast",
          "",
        ].join("\n"),
        "/tmp/plan.md",
      );
      expect(parsed.globalConstraints).toContain("Constraint text");
      expect(parsed.globalConstraints).not.toContain("File Map");
      expect(parsed.globalConstraints).not.toContain("some/path.mjs");
    });

    it("ends the final task block before a following non-canonical heading", () => {
      const parsed = parsePlanText(
        [
          "## Task 1: A",
          "",
          "**Implementer tier:** Fast",
          "",
          "Task body.",
          "",
          "## Execution Gate",
          "",
          "Gate text.",
          "",
        ].join("\n"),
        "/tmp/plan.md",
      );
      expect(parsed.tasks[0].body).toContain("Task body");
      expect(parsed.tasks[0].body).not.toContain("Execution Gate");
      expect(parsed.tasks[0].body).not.toContain("Gate text");
    });

    it("parses this repository's own plan with correct section boundaries", () => {
      const planPath = "docs/superpowers/plans/2026-07-31-deterministic-sdd-source.md";
      const parsed = parsePlanText(readFileSync(planPath, "utf8"), planPath);

      expect(parsed.tasks).toHaveLength(10);
      expect(parsed.tasks.map((task) => task.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      for (const task of parsed.tasks) {
        expect(task.implementerTier).not.toBeNull();
      }
      expect(parsed.globalConstraints).not.toContain("File Map");
      expect(parsed.tasks[9].body).not.toContain("Execution Gate");
    });
  });
});

describe("deterministic SDD tier formulas", () => {
  it("derives reviewer tiers with a Standard floor and Frontier cap", () => {
    expect(["economy", "fast", "standard", "advanced", "capable", "frontier"].map(reviewerTier))
      .toEqual(["standard", "standard", "advanced", "capable", "frontier", "frontier"]);
  });

  it("escalates only fix rounds four and five", () => {
    expect([1, 2, 3, 4, 5].map((round) => fixerTier("advanced", round)))
      .toEqual(["advanced", "advanced", "advanced", "capable", "frontier"]);
    expect(reReviewerTier("economy")).toBe("standard");
    expect(reReviewerTier("capable")).toBe("frontier");
  });

  it("caps fixer escalation at Frontier", () => {
    expect([1, 3, 4, 5].map((round) => fixerTier("capable", round)))
      .toEqual(["capable", "capable", "frontier", "frontier"]);
    expect(fixerTier("frontier", 5)).toBe("frontier");
  });

  it("places the re-reviewer below the fixer at round five, as the plan specifies", () => {
    // Plan Step 9 defines re-reviewer as max(Standard, implementer+1) with no
    // round input, while the fixer gains two rungs at round 5. The documented
    // consequence is that a round-5 fix is re-reviewed one rung below the tier
    // that produced it. This test pins that behavior so it stays a visible
    // decision rather than an accident; changing it requires changing the plan.
    for (const implementer of ["fast", "standard", "advanced"]) {
      const fixer = fixerTier(implementer, 5);
      const reviewer = reReviewerTier(implementer);
      expect(TIERS.indexOf(reviewer)).toBeLessThan(TIERS.indexOf(fixer));
    }
    expect(fixerTier("advanced", 5)).toBe("frontier");
    expect(reReviewerTier("advanced")).toBe("capable");
  });

  it("makes reviewer and re-reviewer identical for every tier", () => {
    for (const tier of TIERS) {
      expect(reReviewerTier(tier)).toBe(reviewerTier(tier));
    }
  });

  it("rejects an unknown tier in every formula", () => {
    expect(() => reviewerTier("Turbo")).toThrow(/unknown tier/iu);
    expect(() => reReviewerTier("turbo")).toThrow(/unknown tier/iu);
    expect(() => fixerTier("Turbo", 1)).toThrow(/unknown tier/iu);
    // Tier identifiers are lowercase. TitleCase is display text and must not
    // resolve, because a TitleCase value reaching a formula means it bypassed
    // the parser's normalization rather than that it needs coercing.
    expect(() => reviewerTier("Advanced")).toThrow(/unknown tier/iu);
  });

  it("rejects fix rounds outside one through five", () => {
    for (const round of [0, 6, -1, 1.5, Number.NaN, "2", null, undefined]) {
      expect(() => fixerTier("advanced", round), `round ${String(round)}`).toThrow(/round/iu);
    }
  });

  describe("roleTier", () => {
    it("resolves each role and emits the matching tier echo", () => {
      expect(roleTier({ implementer: "advanced", role: "implementer" })).toEqual({
        tier: "advanced",
        echo: "Model tier: advanced",
        directive: "Model tier: advanced",
      });
      expect(roleTier({ implementer: "advanced", role: "task-reviewer" })).toEqual({
        tier: "capable",
        echo: "Model tier: capable",
        directive: "Model tier: capable",
      });
      expect(roleTier({ implementer: "advanced", role: "re-reviewer" })).toEqual({
        tier: "capable",
        echo: "Model tier: capable",
        directive: "Model tier: capable",
      });
      expect(roleTier({ implementer: "advanced", role: "final" })).toEqual({
        tier: "frontier",
        echo: "Model tier: frontier",
        directive: "Model tier: frontier",
      });
      expect(roleTier({ implementer: "advanced", role: "fixer", round: 4 })).toEqual({
        tier: "capable",
        echo: "Model tier: capable",
        directive: "Model tier: capable",
      });
    });

    it("requires a round for the fixer role and rejects it elsewhere", () => {
      expect(() => roleTier({ implementer: "advanced", role: "fixer" })).toThrow(/round/iu);
      expect(() => roleTier({ implementer: "advanced", role: "implementer", round: 2 }))
        .toThrow(/round/iu);
      expect(() => roleTier({ implementer: "advanced", role: "task-reviewer", round: 1 }))
        .toThrow(/round/iu);
    });

    it("rejects an unknown role", () => {
      expect(() => roleTier({ implementer: "advanced", role: "architect" })).toThrow(/unknown role/iu);
    });
  });
});

const CLI = "optional-skills/deterministic-subagent-driven-development/scripts/sdd-state";
const temporaryRoots = [];

function makeTemporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "sdd-cli-test-"));
  temporaryRoots.push(root);
  return root;
}

function runCli(args) {
  return spawnSync(CLI, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("sdd-state CLI", () => {
  it("validates a good plan with an independently computed digest", () => {
    const root = makeTemporaryDirectory();
    const planPath = join(root, "plan.md");
    writeFileSync(planPath, VALID_PLAN);

    const result = runCli(["validate-plan", planPath]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const payload = JSON.parse(result.stdout);
    const expectedDigest = createHash("sha256").update(readFileSync(planPath)).digest("hex");
    expect(payload.planDigest).toBe(expectedDigest);
    expect(payload.tasks).toEqual([
      { number: 1, title: "Mechanical fixture", implementerTier: "economy" },
      { number: 2, title: "Integrated behavior", implementerTier: "advanced" },
    ]);
  });

  it("exits 2 with stderr and no stdout for an invalid plan", () => {
    const root = makeTemporaryDirectory();
    const planPath = join(root, "bad.md");
    writeFileSync(planPath, "## Task 2: Starts at two\n\n**Implementer tier:** Fast\n");

    const result = runCli(["validate-plan", planPath]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/expected Task 1/u);
  });

  it("exits 2 for a missing plan file", () => {
    const result = runCli(["validate-plan", join(makeTemporaryDirectory(), "absent.md")]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("resolves every role through role-tier", () => {
    const expectations = [
      [["--implementer", "advanced", "--role", "implementer"], "advanced"],
      [["--implementer", "advanced", "--role", "task-reviewer"], "capable"],
      [["--implementer", "advanced", "--role", "re-reviewer"], "capable"],
      [["--implementer", "advanced", "--role", "final"], "frontier"],
      [["--implementer", "advanced", "--role", "fixer", "--round", "4"], "capable"],
      [["--implementer", "economy", "--role", "task-reviewer"], "standard"],
    ];
    for (const [args, tier] of expectations) {
      const result = runCli(["role-tier", ...args]);
      expect(result.status, `${args.join(" ")} -> ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        tier,
        echo: `Model tier: ${tier}`,
        directive: `Model tier: ${tier}`,
      });
    }
  });

  it("rejects a missing or irrelevant round through the CLI", () => {
    const missing = runCli(["role-tier", "--implementer", "advanced", "--role", "fixer"]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/round/iu);

    const irrelevant = runCli([
      "role-tier", "--implementer", "advanced", "--role", "implementer", "--round", "2",
    ]);
    expect(irrelevant.status).toBe(2);
    expect(irrelevant.stderr).toMatch(/round/iu);
  });

  it("rejects an unknown subcommand, role, and tier", () => {
    expect(runCli(["frobnicate"]).status).toBe(2);
    expect(runCli(["role-tier", "--implementer", "advanced", "--role", "architect"]).status).toBe(2);
    expect(runCli(["role-tier", "--implementer", "Turbo", "--role", "implementer"]).status).toBe(2);
  });

  it("has no CLI output or exit side effect when imported", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'const m = await import("./optional-skills/deterministic-subagent-driven-development/scripts/sdd-state.mjs");',
          'if (typeof m.parsePlanText !== "function") throw new Error("missing export");',
          'process.stdout.write("IMPORT_CLEAN");',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(probe.status).toBe(0);
    expect(probe.stdout).toBe("IMPORT_CLEAN");
    expect(probe.stderr).toBe("");
  });
});

describe("tier identifiers match the dispatch boundary", () => {
  // The production tool accepts only these values. Task 4 originally emitted
  // TitleCase, which every spawn_subsession call would have rejected at schema
  // validation. Nothing caught it because no test crossed the boundary. This
  // test is that crossing: it pins the exact contract the tool enforces.
  const TOOL_ACCEPTED_TIERS = ["economy", "fast", "standard", "advanced", "capable", "frontier"];

  it("uses exactly the tier values spawn_subsession accepts, in ladder order", () => {
    expect([...TIERS]).toEqual(TOOL_ACCEPTED_TIERS);
  });

  it("resolves every role to a tool-acceptable tier for every implementer tier", () => {
    for (const implementer of TIERS) {
      for (const role of ["implementer", "task-reviewer", "re-reviewer", "final"]) {
        const { tier } = roleTier({ implementer, role });
        expect(TOOL_ACCEPTED_TIERS, `${role} from ${implementer}`).toContain(tier);
      }
      for (const round of [1, 2, 3, 4, 5]) {
        const { tier } = roleTier({ implementer, role: "fixer", round });
        expect(TOOL_ACCEPTED_TIERS, `fixer round ${String(round)} from ${implementer}`).toContain(tier);
      }
    }
  });

  it("parses a TitleCase plan field into a lowercase identifier", () => {
    const parsed = parsePlanText(
      "## Task 1: A\n\n**Implementer tier:** Frontier\n",
      "/tmp/plan.md",
    );
    expect(parsed.tasks[0].implementerTier).toBe("frontier");
    expect(TOOL_ACCEPTED_TIERS).toContain(parsed.tasks[0].implementerTier);
  });

  it("renders display labels without reintroducing them as identifiers", () => {
    expect(tierLabel("frontier")).toBe("Frontier");
    expect(tierLabel("economy")).toBe("Economy");
    expect(() => tierLabel("Frontier")).toThrow(/unknown tier/iu);
  });

  it("emits a lowercase tier echo with a compatibility alias", () => {
    expect(tierEcho("capable")).toBe("Model tier: capable");
    expect(tierDirective("capable")).toBe("Model tier: capable");
  });
});

const BASE_INIT = Object.freeze({
  planPath: "/repo/docs/plan.md",
  planDigest: "a".repeat(64),
  repoRoot: "/repo",
  worktree: "/repo-worktree",
  runRoot: "/repo-worktree/.superpowers/sdd/example-a1b2c3d4",
  branch: "feature/example",
  baseRef: "main",
  mergeBase: "b".repeat(40),
  tasks: [
    { number: 1, implementerTier: "economy" },
    { number: 2, implementerTier: "advanced" },
  ],
  at: "2026-07-31T00:00:00.000Z",
});

const init = (overrides = {}) => createInitialState({ ...BASE_INIT, ...overrides });

describe("createInitialState", () => {
  it("constructs every version-1 field explicitly", () => {
    expect(init()).toMatchObject({
      version: 1,
      revision: 0,
      phase: "CAPABILITY_CHECK",
      currentTask: 1,
      currentImplementerTier: "economy",
      contextAttempts: 0,
      fixRound: 0,
      finalFixUsed: false,
      dispatch: null,
    });
  });

  it("derives runId from plan digest and pinned Git identity", () => {
    const expected = createHash("sha256")
      .update(
        [
          BASE_INIT.planDigest,
          BASE_INIT.worktree,
          BASE_INIT.branch,
          BASE_INIT.mergeBase,
          BASE_INIT.at,
        ].join("\u0000"),
      )
      .digest("hex");
    expect(init().runId).toBe(expected);
  });

  it("changes runId when any identity input changes", () => {
    expect(init({ branch: "feature/other" }).runId).not.toBe(init().runId);
    expect(init({ mergeBase: "c".repeat(40) }).runId).not.toBe(init().runId);
  });

  it("stores the immutable task/tier index and deep-freezes state", () => {
    const state = init();
    expect(state.tasks).toEqual([
      { number: 1, implementerTier: "economy" },
      { number: 2, implementerTier: "advanced" },
    ]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tasks)).toBe(true);
    expect(() => {
      state.tasks[0].implementerTier = "frontier";
    }).toThrow();
  });

  it("does not retain a reference to caller-owned task input", () => {
    const tasks = [{ number: 1, implementerTier: "economy" }];
    const state = createInitialState({ ...BASE_INIT, tasks });
    tasks[0].implementerTier = "frontier";
    expect(state.tasks[0].implementerTier).toBe("economy");
  });

  it("rejects an invalid ladder tier", () => {
    expect(() => init({ tasks: [{ number: 1, implementerTier: "Capable" }] })).toThrow(
      /implementerTier/u,
    );
    expect(() => init({ tasks: [{ number: 1, implementerTier: "turbo" }] })).toThrow(
      /implementerTier/u,
    );
  });

  it("rejects malformed identity fields", () => {
    expect(() => init({ planDigest: "a".repeat(63) })).toThrow(/planDigest/u);
    expect(() => init({ mergeBase: "zz" })).toThrow(/mergeBase/u);
    expect(() => init({ worktree: "relative/path" })).toThrow(/worktree/u);
    expect(() => init({ runRoot: "/elsewhere/run" })).toThrow(/runRoot/u);
    expect(() => init({ at: "not-a-timestamp" })).toThrow(/at/u);
  });

  it("requires at least one task with contiguous numbering", () => {
    expect(() => init({ tasks: [] })).toThrow(/tasks/u);
    expect(() =>
      init({
        tasks: [
          { number: 1, implementerTier: "economy" },
          { number: 3, implementerTier: "advanced" },
        ],
      }),
    ).toThrow(/contiguous/u);
  });
});

describe("reduceState capability and plan gates", () => {
  const at = "2026-07-31T00:01:00.000Z";

  it("blocks on a missing capability", () => {
    const next = reduceState(init(), {
      type: "capability-missing",
      reason: "get_model_policy unavailable",
      at,
    });
    expect(next.phase).toBe("CAPABILITY_BLOCKED");
    expect(next.revision).toBe(1);
  });

  it("advances a confirmed capability to the plan gate", () => {
    const next = reduceState(init(), {
      type: "capability-confirmed",
      mode: "tiered",
      at,
    });
    expect(next.phase).toBe("PLAN_VALIDATE");
  });

  it("accepts a valid exact-mode capability", () => {
    const next = reduceState(init(), {
      type: "capability-confirmed",
      mode: "exact",
      at,
    });
    expect(next.phase).toBe("PLAN_VALIDATE");
  });

  it("increments revision exactly once per transition", () => {
    const one = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    const two = reduceState(one, { type: "plan-valid", planDigest: BASE_INIT.planDigest, at });
    expect([one.revision, two.revision]).toEqual([1, 2]);
  });

  it("records a single-line lastTransition", () => {
    const next = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    expect(next.lastTransition).toContain("capability-confirmed");
    expect(next.lastTransition).not.toMatch(/\r|\n/u);
  });

  it("blocks an invalid plan and a digest conflict", () => {
    const gated = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    expect(
      reduceState(gated, { type: "plan-invalid", reason: "no tier on task 2", at }).phase,
    ).toBe("PLAN_INVALID");
    expect(
      reduceState(gated, { type: "plan-conflict", planDigest: "d".repeat(64), at }).phase,
    ).toBe("PLAN_INVALID");
  });

  it("requires a validated plan before any preflight observation", () => {
    const gated = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    expect(() => reduceState(gated, { type: "preflight-clean", at })).toThrow(/validated plan/u);
  });

  it("requires a persisted ruling to leave a preflight decision", () => {
    const gated = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    const valid = reduceState(gated, { type: "plan-valid", planDigest: BASE_INIT.planDigest, at });
    expect(valid.phase).toBe("PLAN_VALIDATE");
    const pending = reduceState(valid, {
      type: "preflight-conflict",
      reason: "worktree is dirty",
      at,
    });
    expect(pending.phase).toBe("PREFLIGHT_DECISION_REQUIRED");
    expect(() =>
      reduceState(pending, { type: "plan-valid", planDigest: BASE_INIT.planDigest, at }),
    ).toThrow(/illegal transition/u);
    expect(
      reduceState(pending, { type: "preflight-approved", reason: "generated files only", at }).phase,
    ).toBe("WORKSPACE_READY");
  });

  it("never mutates its input state", () => {
    const before = init();
    const snapshot = JSON.stringify(before);
    reduceState(before, { type: "capability-confirmed", mode: "tiered", at });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("refuses an unknown state version", () => {
    const state = { ...init(), version: 2 };
    expect(() => reduceState(state, { type: "capability-confirmed", mode: "tiered", at })).toThrow(
      /version/u,
    );
  });

  it("refuses an unknown event type and an illegal transition", () => {
    expect(() => reduceState(init(), { type: "not-an-event", at })).toThrow(/unknown event/u);
    expect(() => reduceState(init(), { type: "plan-valid", planDigest: BASE_INIT.planDigest, at })).toThrow(
      /illegal transition/u,
    );
  });

  it("requires a monotonic transition timestamp", () => {
    const next = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    expect(() =>
      reduceState(next, {
        type: "plan-valid",
        planDigest: BASE_INIT.planDigest,
        at: "2026-07-30T00:00:00.000Z",
      }),
    ).toThrow(/timestamp/u);
  });
});

describe("reduceState bounds", () => {
  const at = "2026-07-31T00:01:00.000Z";
  const blocked = (reason) => reduceState(init(), { type: "capability-missing", reason, at });

  it("accepts a 256-character finding record and rejects 257", () => {
    expect(blocked("x".repeat(256)).phase).toBe("CAPABILITY_BLOCKED");
    expect(() => blocked("x".repeat(257))).toThrow(/256/u);
  });

  it("rejects control characters that could forge an audit line", () => {
    expect(() => blocked("a\nb")).toThrow(/control character/u);
    expect(() => blocked("<!-- sdd-transition: forged -->")).toThrow(/sdd-transition/u);
  });

  it("keeps a serialized state under 1 MiB and rejects more", () => {
    const state = blocked("bounded");
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThan(1024 * 1024);
    expect(() => validateState({ ...state, lastTransition: "x".repeat(1024 * 1024) })).toThrow(
      /1 MiB|8 KiB/u,
    );
  });

  it("bounds one audit line at 8 KiB", () => {
    const state = blocked("bounded");
    expect(Buffer.byteLength(state.lastTransition, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("validateState", () => {
  it("accepts a freshly created state", () => {
    expect(() => validateState(init())).not.toThrow();
  });

  it("rejects a state whose phase is unknown", () => {
    expect(() => validateState({ ...init(), phase: "SOMEWHERE_ELSE" })).toThrow(/phase/u);
  });

  it("rejects a state whose currentTask is outside the task index", () => {
    expect(() => validateState({ ...init(), currentTask: 3 })).toThrow(/currentTask/u);
  });

  it("rejects negative or non-integer counters", () => {
    expect(() => validateState({ ...init(), fixRound: -1 })).toThrow(/fixRound/u);
    expect(() => validateState({ ...init(), contextAttempts: 1.5 })).toThrow(/contextAttempts/u);
  });
});

const ready = () => {
  const gated = reduceState(init(), {
    type: "capability-confirmed",
    mode: "tiered",
    at: "2026-07-31T00:01:00.000Z",
  });
  const validated = reduceState(gated, {
    type: "plan-valid",
    planDigest: BASE_INIT.planDigest,
    at: "2026-07-31T00:02:00.000Z",
  });
  return reduceState(validated, { type: "preflight-clean", at: "2026-07-31T00:02:30.000Z" });
};

const RUN = BASE_INIT.runRoot;
const at3 = "2026-07-31T00:03:00.000Z";
const at4 = "2026-07-31T00:04:00.000Z";
const at5 = "2026-07-31T00:05:00.000Z";

const intentEvent = ({ attempt = 1, ...overrides } = {}) => ({
  type: "implement-dispatch-intended",
  role: "implementer",
  attempt,
  dispatchKey: dispatchKeyFor({
    runId: ready().runId,
    task: 1,
    role: "implementer",
    attempt,
  }),
  tier: "economy",
  promptPath: `${RUN}/task-1-implementer-prompt.md`,
  reportPath: `${RUN}/task-1-implementer-report.md`,
  briefPath: `${RUN}/task-1-brief.md`,
  expectedOutcome: "implementer-report",
  renderedPrompt: "Implement task 1.\n",
  at: at3,
  ...overrides,
});

const intended = (overrides = {}) => reduceState(ready(), intentEvent(overrides));

// The task reviewer runs at implementer+1 with a Standard floor, so an economy
// implementer yields standard rather than fast.
const reviewIntentEvent = (overrides = {}) => ({
  type: "task-review-dispatch-intended",
  role: "task-reviewer",
  dispatchKey: dispatchKeyFor({
    runId: ready().runId,
    task: 1,
    role: "task-reviewer",
    attempt: 1,
  }),
  tier: "standard",
  promptPath: `${RUN}/task-1-review-prompt.md`,
  reportPath: `${RUN}/task-1-review-report.md`,
  briefPath: `${RUN}/task-1-brief.md`,
  attempt: 1,
  expectedOutcome: "review-report",
  renderedPrompt: "Review task 1.\n",
  at: "2026-07-31T00:07:00.000Z",
  ...overrides,
});

const started = () =>
  reduceState(intended(), {
    type: "dispatch-started",
    sessionId: "019fb673-4324-7c1d-98a2-3c638e29f810",
    at: at4,
  });

describe("dispatchKeyFor", () => {
  it("composes controller-owned identity without a round for non-fix roles", () => {
    expect(
      dispatchKeyFor({ runId: "f".repeat(64), task: 2, role: "task-reviewer", attempt: 1 }),
    ).toBe(`${"f".repeat(64)}:task-2:task-reviewer:attempt-1`);
  });

  it("includes the round for the fixer role", () => {
    expect(
      dispatchKeyFor({ runId: "f".repeat(64), task: 2, role: "fixer", attempt: 1, round: 3 }),
    ).toBe(`${"f".repeat(64)}:task-2:fixer:attempt-1:round-3`);
  });

  it("requires a round for the fixer and rejects one elsewhere", () => {
    expect(() =>
      dispatchKeyFor({ runId: "f".repeat(64), task: 1, role: "fixer", attempt: 1 }),
    ).toThrow(/round/u);
    expect(() =>
      dispatchKeyFor({ runId: "f".repeat(64), task: 1, role: "implementer", attempt: 1, round: 1 }),
    ).toThrow(/round/u);
  });

  it("stays inside the bounded key grammar", () => {
    const key = dispatchKeyFor({ runId: "f".repeat(64), task: 10, role: "re-reviewer", attempt: 2 });
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,240}$/u);
  });
});

describe("task dispatch intent", () => {
  it("enters WORKSPACE_READY from an accepted plan", () => {
    expect(ready().phase).toBe("WORKSPACE_READY");
  });

  it("records a complete intent before any session exists", () => {
    const state = intended();
    expect(state.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(state.dispatch).toMatchObject({
      role: "implementer",
      tier: "economy",
      attempt: 1,
      sessionId: null,
      renderedPrompt: "Implement task 1.\n",
    });
  });

  it("rejects an intent whose rendered prompt is absent", () => {
    expect(() => intended({ renderedPrompt: undefined })).toThrow(/renderedPrompt/u);
    expect(() => intended({ renderedPrompt: "" })).toThrow(/renderedPrompt/u);
  });

  it("accepts a rendered prompt with no leading tier label", () => {
    expect(intended({ renderedPrompt: "No label at all.\n" }).dispatch.renderedPrompt).toBe(
      "No label at all.\n",
    );
  });

  it("accepts a leading tier label that agrees with the typed tier", () => {
    expect(
      intended({ renderedPrompt: "Model tier: economy\n\nImplement task 1.\n" }).dispatch.tier,
    ).toBe("economy");
  });

  it("reports a leading tier label that disagrees with the typed tier", () => {
    expect(() =>
      intended({ renderedPrompt: "Model tier: frontier\n\nImplement task 1.\n" }),
    ).toThrow(/divergence/u);
  });

  it("rejects a tier differing from the role formula", () => {
    expect(() => intended({ tier: "frontier" })).toThrow(/formula/u);
  });

  it("rejects a malformed key and a key not matching the run", () => {
    expect(() => intended({ dispatchKey: "has spaces" })).toThrow(/dispatchKey/u);
    expect(() => intended({ dispatchKey: `${"0".repeat(64)}:task-1:implementer:attempt-1` })).toThrow(
      /dispatchKey/u,
    );
  });

  it("rejects artifact paths outside the pinned run root", () => {
    expect(() => intended({ reportPath: "/tmp/elsewhere/report.md" })).toThrow(/reportPath/u);
    expect(() => intended({ promptPath: `${RUN}/../escape.md` })).toThrow(/promptPath/u);
    expect(() => intended({ briefPath: "relative/brief.md" })).toThrow(/briefPath/u);
  });

  it("bounds the stored rendered prompt at 384 KiB", () => {
    expect(() => intended({ renderedPrompt: "x".repeat(384 * 1024 + 1) })).toThrow(/384/u);
  });

  it("refuses a second dispatch while one is running", () => {
    expect(() => reduceState(started(), intentEvent({ at: at5 }))).toThrow(/illegal transition/u);
  });
});

describe("dispatch correlation and ambiguity", () => {
  it("records the returned session id against the intent", () => {
    const state = started();
    expect(state.phase).toBe("IMPLEMENT_RUNNING");
    expect(state.dispatch).toMatchObject({
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f810",
      dispatchKey: intentEvent().dispatchKey,
    });
  });

  it("keeps the stored prompt bytes byte-for-byte through correlation", () => {
    expect(started().dispatch.renderedPrompt).toBe("Implement task 1.\n");
  });

  it("enters DISPATCH_AMBIGUOUS when the spawn window was crossed", () => {
    const state = reduceState(intended(), {
      type: "dispatch-window-crossed",
      reason: "controller restarted before the session id was recorded",
      at: at4,
    });
    expect(state.phase).toBe("DISPATCH_AMBIGUOUS");
    expect(state.dispatch.sessionId).toBeNull();
    expect(state.dispatch.renderedPrompt).toBe("Implement task 1.\n");
  });

  it("never resolves ambiguity on its own", () => {
    const ambiguous = reduceState(intended(), {
      type: "dispatch-window-crossed",
      reason: "restart",
      at: at4,
    });
    expect(() =>
      reduceState(ambiguous, {
        type: "dispatch-started",
        sessionId: "019fb673-4324-7c1d-98a2-3c638e29f811",
        at: at5,
      }),
    ).toThrow(/illegal transition/u);
  });

  it("adopts an observed child only through an explicit ruling", () => {
    const ambiguous = reduceState(intended(), {
      type: "dispatch-window-crossed",
      reason: "restart",
      at: at4,
    });
    const adopted = reduceState(ambiguous, {
      type: "dispatch-ruling-recorded",
      decision: "adopt",
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f812",
      reason: "single child observed with matching cwd",
      at: at5,
    });
    expect(adopted.phase).toBe("IMPLEMENT_RUNNING");
    expect(adopted.dispatch.sessionId).toBe("019fb673-4324-7c1d-98a2-3c638e29f812");
  });

  it("requires a session id to adopt and forbids one to reissue", () => {
    const ambiguous = reduceState(intended(), {
      type: "dispatch-window-crossed",
      reason: "restart",
      at: at4,
    });
    expect(() =>
      reduceState(ambiguous, {
        type: "dispatch-ruling-recorded",
        decision: "adopt",
        reason: "no id supplied",
        at: at5,
      }),
    ).toThrow(/sessionId/u);
    expect(() =>
      reduceState(ambiguous, {
        type: "dispatch-ruling-recorded",
        decision: "reissue",
        sessionId: "019fb673-4324-7c1d-98a2-3c638e29f813",
        reason: "contradictory",
        at: at5,
      }),
    ).toThrow(/sessionId/u);
  });

  it("returns a reissue ruling to intent with the stored bytes intact", () => {
    const ambiguous = reduceState(intended(), {
      type: "dispatch-window-crossed",
      reason: "restart",
      at: at4,
    });
    const reissued = reduceState(ambiguous, {
      type: "dispatch-ruling-recorded",
      decision: "reissue",
      reason: "no child found; accepting a possible orphan",
      at: at5,
    });
    expect(reissued.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(reissued.dispatch.renderedPrompt).toBe("Implement task 1.\n");
    expect(reissued.dispatch.sessionId).toBeNull();
    expect(reissued.dispatch.reissued).toBe(true);
  });
});

describe("implementer result classification", () => {
  const finished = () =>
    reduceState(started(), {
      type: "implementer-finished",
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: at5,
    });

  const record = (status, extra = {}) =>
    reduceState(finished(), {
      type: "implementer-status-recorded",
      status,
      at: "2026-07-31T00:06:00.000Z",
      ...extra,
    });

  it("records the report before any status is classified", () => {
    const state = finished();
    expect(state.phase).toBe("IMPLEMENT_RESULT");
    expect(state.dispatch.status).toBeNull();
  });

  it("rejects an undefined status token", () => {
    expect(() => record("DONE_ISH")).toThrow(/status/u);
  });

  it("pins DONE and then advances to review intent", () => {
    const pinned = record("DONE");
    expect(pinned.phase).toBe("IMPLEMENT_RESULT");
    const next = reduceState(pinned, reviewIntentEvent());
    expect(next.phase).toBe("TASK_REVIEW_DISPATCH_INTENT");
    expect(next.dispatch.tier).toBe("standard");
  });

  it("refuses review intent before a status is pinned", () => {
    expect(() => reduceState(finished(), reviewIntentEvent())).toThrow(/pinned/u);
  });

  it("refuses a hedged status with nothing to adjudicate", () => {
    // A live role run returned exactly this after three escalating revisions of
    // the prose contract. The guard is why the prose is now redundant rather
    // than load-bearing.
    expect(() => record("DONE_WITH_CONCERNS")).toThrow(/at least one concern/u);
    expect(() => record("DONE_WITH_CONCERNS", { concerns: [] })).toThrow(/at least one concern/u);
  });

  it("passes an observational concern straight through", () => {
    const pinned = record("DONE_WITH_CONCERNS", {
      concerns: [{ kind: "observational", note: "naming could be clearer" }],
    });
    expect(pinned.phase).toBe("IMPLEMENT_RESULT");
    expect(pinned.dispatch.concerns).toHaveLength(1);
  });

  it("requires a ruling for a correctness concern", () => {
    const pending = record("DONE_WITH_CONCERNS", {
      concerns: [{ kind: "correctness", note: "the retry bound may be off by one" }],
    });
    expect(pending.phase).toBe("CONCERN_DECISION_REQUIRED");
    expect(() => reduceState(pending, reviewIntentEvent())).toThrow(/illegal transition/u);
    expect(
      reduceState(pending, {
        type: "concern-ruling-recorded",
        decision: "proceed",
        reason: "verified the bound is correct",
        at: "2026-07-31T00:07:00.000Z",
      }).phase,
    ).toBe("IMPLEMENT_RESULT");
  });

  it("blocks on a ruling that rejects the concern", () => {
    const pending = record("DONE_WITH_CONCERNS", {
      concerns: [{ kind: "scope", note: "touched an unrelated module" }],
    });
    expect(
      reduceState(pending, {
        type: "concern-ruling-recorded",
        decision: "block",
        reason: "scope creep must be resolved by a human",
        at: "2026-07-31T00:07:00.000Z",
      }).phase,
    ).toBe("TASK_BLOCKED");
  });

  it("enters TASK_BLOCKED immediately on BLOCKED", () => {
    expect(record("BLOCKED", { reason: "the interface does not exist" }).phase).toBe("TASK_BLOCKED");
  });
});

describe("bounded context retry", () => {
  const needContext = (state, ts) => {
    const finished = reduceState(state, {
      type: "implementer-finished",
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: ts,
    });
    return reduceState(finished, {
      type: "implementer-status-recorded",
      status: "NEEDS_CONTEXT",
      at: ts,
    });
  };

  it("allows two enrichments at the planned tier without touching fixRound", () => {
    const required = needContext(started(), at5);
    expect(required.phase).toBe("CONTEXT_REQUIRED");
    const retry = reduceState(
      required,
      intentEvent({ attempt: 2, type: "context-dispatch-intended", at: "2026-07-31T00:06:00.000Z" }),
    );
    expect(retry.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(retry.contextAttempts).toBe(1);
    expect(retry.currentImplementerTier).toBe("economy");
    expect(retry.fixRound).toBe(0);
  });

  it("blocks the third NEEDS_CONTEXT without incrementing fixRound", () => {
    let state = needContext(started(), at5);
    for (const [attempt, minute] of [
      [2, "06"],
      [3, "08"],
    ]) {
      state = reduceState(
        state,
        intentEvent({
          attempt,
          type: "context-dispatch-intended",
          at: `2026-07-31T00:${minute}:00.000Z`,
        }),
      );
      state = reduceState(state, {
        type: "dispatch-started",
        sessionId: `019fb673-4324-7c1d-98a2-3c638e29f81${String(attempt)}`,
        at: `2026-07-31T00:${minute}:30.000Z`,
      });
      state = needContext(state, `2026-07-31T00:${String(Number(minute) + 1).padStart(2, "0")}:00.000Z`);
    }
    expect(state.contextAttempts).toBe(2);
    expect(state.phase).toBe("CONTEXT_REQUIRED");

    expect(() =>
      reduceState(
        state,
        intentEvent({
          attempt: 4,
          type: "context-dispatch-intended",
          at: "2026-07-31T00:12:00.000Z",
        }),
      ),
    ).toThrow(/bounded at 2/u);

    const blocked = reduceState(state, {
      type: "context-limit-reached",
      reason: "three context attempts exhausted",
      at: "2026-07-31T00:12:00.000Z",
    });
    expect(blocked.phase).toBe("TASK_BLOCKED");
    expect(blocked.fixRound).toBe(0);
  });
});

/** Drive a task to TASK_REVIEW_RUNNING with a reviewer child in flight. */
const reviewRunning = () => {
  const finished = reduceState(started(), {
    type: "implementer-finished",
    reportPath: `${RUN}/task-1-implementer-report.md`,
    at: at5,
  });
  const pinned = reduceState(finished, {
    type: "implementer-status-recorded",
    status: "DONE",
    at: "2026-07-31T00:06:00.000Z",
  });
  const intent = reduceState(pinned, reviewIntentEvent());
  return reduceState(intent, {
    type: "dispatch-started",
    sessionId: "019fb673-4324-7c1d-98a2-3c638e29f820",
    at: "2026-07-31T00:08:00.000Z",
  });
};

const reviewFinished = (overrides = {}) =>
  reduceState(reviewRunning(), {
    type: "task-review-finished",
    reportPath: `${RUN}/task-1-review-report.md`,
    specStatus: "PASS",
    qualityStatus: "APPROVED",
    at: "2026-07-31T00:09:00.000Z",
    ...overrides,
  });

const CRITICAL = [{ id: "F-1", severity: "Critical", summary: "the bound is off by one" }];
const MINOR = [{ id: "F-2", severity: "Minor", summary: "naming could be clearer" }];

/** A fix intent for the given round; the fixer tier escalates at rounds 4 and 5. */
const fixIntentEvent = (round, overrides = {}) => ({
  type: "fix-dispatch-intended",
  role: "fixer",
  attempt: 1,
  dispatchKey: dispatchKeyFor({
    runId: ready().runId,
    task: 1,
    role: "fixer",
    attempt: 1,
    round,
  }),
  tier: fixerTier("economy", round),
  promptPath: `${RUN}/task-1-fix-${String(round)}-prompt.md`,
  reportPath: `${RUN}/task-1-fix-${String(round)}-report.md`,
  briefPath: `${RUN}/task-1-brief.md`,
  expectedOutcome: "fix-report",
  renderedPrompt: `Fix round ${String(round)}.\n`,
  at: "2026-07-31T00:10:00.000Z",
  ...overrides,
});

describe("task review decision", () => {
  it("records the reviewer verdict without choosing a phase", () => {
    const state = reviewFinished();
    expect(state.phase).toBe("TASK_REVIEW_DECISION");
    expect(state.reviewOutcome).toMatchObject({ specStatus: "PASS", qualityStatus: "APPROVED" });
  });

  it("requires both axes to be explicit", () => {
    expect(() => reviewFinished({ specStatus: undefined })).toThrow(/specStatus/u);
    expect(() => reviewFinished({ qualityStatus: "LGTM" })).toThrow(/qualityStatus/u);
  });

  it("completes a task only on spec PASS plus quality APPROVED", () => {
    const approved = reduceState(reviewFinished(), {
      type: "review-approved",
      at: "2026-07-31T00:10:00.000Z",
    });
    expect(approved.phase).toBe("TASK_COMPLETE");
  });

  it("refuses completion on a spec failure or requested changes", () => {
    expect(() =>
      reduceState(reviewFinished({ specStatus: "FAIL" }), {
        type: "review-approved",
        at: "2026-07-31T00:10:00.000Z",
      }),
    ).toThrow(/spec PASS/u);
    expect(() =>
      reduceState(reviewFinished({ qualityStatus: "CHANGES_REQUESTED" }), {
        type: "review-approved",
        at: "2026-07-31T00:10:00.000Z",
      }),
    ).toThrow(/quality APPROVED/u);
  });

  it("refuses completion while a load-bearing finding is open", () => {
    const withFinding = reviewFinished({ findings: CRITICAL });
    expect(() =>
      reduceState(withFinding, { type: "review-approved", at: "2026-07-31T00:10:00.000Z" }),
    ).toThrow(/load-bearing/u);
  });

  it("opens a fix round for a load-bearing finding", () => {
    const withFinding = reviewFinished({
      findings: CRITICAL,
      qualityStatus: "CHANGES_REQUESTED",
    });
    const fixing = reduceState(withFinding, fixIntentEvent(1));
    expect(fixing.phase).toBe("FIX_DISPATCH_INTENT");
    expect(fixing.fixRound).toBe(1);
    expect(fixing.dispatch.tier).toBe("economy");
  });

  it("refuses a fix round when nothing needs fixing", () => {
    expect(() => reduceState(reviewFinished(), fixIntentEvent(1))).toThrow(/requires a spec/u);
  });

  it("blocks on an explicit review block", () => {
    const blocked = reduceState(reviewFinished({ specStatus: "FAIL" }), {
      type: "review-blocked",
      reason: "the task premise is wrong",
      at: "2026-07-31T00:10:00.000Z",
    });
    expect(blocked.phase).toBe("TASK_BLOCKED");
  });
});

/** Drive to REREVIEW_RUNNING after one fix round on a critical finding. */
const rereviewRunning = (round = 1) => {
  let state = reduceState(
    reviewFinished({ findings: CRITICAL, qualityStatus: "CHANGES_REQUESTED" }),
    fixIntentEvent(round),
  );
  state = reduceState(state, {
    type: "dispatch-started",
    sessionId: "019fb673-4324-7c1d-98a2-3c638e29f830",
    at: "2026-07-31T00:11:00.000Z",
  });
  state = reduceState(state, {
    type: "rereview-dispatch-intended",
    role: "re-reviewer",
    attempt: 1,
    dispatchKey: dispatchKeyFor({
      runId: ready().runId,
      task: 1,
      role: "re-reviewer",
      attempt: 1,
    }),
    tier: reReviewerTier("economy"),
    promptPath: `${RUN}/task-1-rereview-prompt.md`,
    reportPath: `${RUN}/task-1-rereview-report.md`,
    briefPath: `${RUN}/task-1-brief.md`,
    expectedOutcome: "rereview-report",
    renderedPrompt: "Re-review the fix.\n",
    findingResolutions: [{ id: "F-1", disposition: "fixed", evidence: "commit abc1234" }],
    at: "2026-07-31T00:12:00.000Z",
  });
  return reduceState(state, {
    type: "dispatch-started",
    sessionId: "019fb673-4324-7c1d-98a2-3c638e29f831",
    at: "2026-07-31T00:13:00.000Z",
  });
};

const rereviewFinished = (overrides = {}) =>
  reduceState(rereviewRunning(), {
    type: "rereview-finished",
    reportPath: `${RUN}/task-1-rereview-report.md`,
    specStatus: "PASS",
    qualityStatus: "APPROVED",
    at: "2026-07-31T00:14:00.000Z",
    ...overrides,
  });

describe("fix and re-review loop", () => {
  it("records fix resolutions when the re-review is dispatched", () => {
    const state = rereviewRunning();
    expect(state.phase).toBe("REREVIEW_RUNNING");
    expect(state.findings[0]).toMatchObject({ id: "F-1", disposition: "fixed" });
  });

  it("pins the re-review result before any adjudication is legal", () => {
    const running = rereviewRunning();
    expect(() =>
      reduceState(running, { type: "rereview-approved", at: "2026-07-31T00:14:00.000Z" }),
    ).toThrow(/recorded review result/u);
    expect(() =>
      reduceState(running, {
        type: "rereview-blocked",
        reason: "still wrong",
        at: "2026-07-31T00:14:00.000Z",
      }),
    ).toThrow(/recorded review result/u);
    expect(() =>
      reduceState(running, {
        ...fixIntentEvent(2, {
          type: "next-fix-dispatch-intended",
          at: "2026-07-31T00:14:00.000Z",
        }),
      }),
    ).toThrow(/recorded review result/u);
  });

  it("refuses to pin a second result for the same round", () => {
    expect(() =>
      reduceState(rereviewFinished(), {
        type: "rereview-finished",
        reportPath: `${RUN}/task-1-rereview-report.md`,
        specStatus: "PASS",
        qualityStatus: "APPROVED",
        at: "2026-07-31T00:15:00.000Z",
      }),
    ).toThrow(/already pinned/u);
  });

  it("completes the task once the fix is approved", () => {
    const approved = reduceState(rereviewFinished(), {
      type: "rereview-approved",
      at: "2026-07-31T00:15:00.000Z",
    });
    expect(approved.phase).toBe("TASK_COMPLETE");
    expect(approved.findings[0].disposition).toBe("fixed");
  });

  it("escalates the fixer tier at rounds 4 and 5", () => {
    expect(fixerTier("standard", 3)).toBe("standard");
    expect(fixerTier("standard", 4)).toBe("advanced");
    expect(fixerTier("standard", 5)).toBe("capable");
  });

  it("caps fix rounds at five", () => {
    let state = rereviewFinished({ specStatus: "FAIL", findings: CRITICAL });
    for (let round = 2; round <= 5; round += 1) {
      state = reduceState(state, {
        ...fixIntentEvent(round, {
          type: "next-fix-dispatch-intended",
          at: `2026-07-31T01:${String(round).padStart(2, "0")}:00.000Z`,
        }),
      });
      expect(state.fixRound).toBe(round);
      state = reduceState(state, {
        type: "dispatch-started",
        sessionId: `019fb673-4324-7c1d-98a2-3c638e29f84${String(round)}`,
        at: `2026-07-31T01:${String(round).padStart(2, "0")}:30.000Z`,
      });
      state = reduceState(state, {
        type: "rereview-dispatch-intended",
        role: "re-reviewer",
        attempt: 1,
        dispatchKey: dispatchKeyFor({
          runId: ready().runId,
          task: 1,
          role: "re-reviewer",
          attempt: 1,
        }),
        tier: reReviewerTier("economy"),
        promptPath: `${RUN}/task-1-rereview-prompt.md`,
        reportPath: `${RUN}/task-1-rereview-report.md`,
        briefPath: `${RUN}/task-1-brief.md`,
        expectedOutcome: "rereview-report",
        renderedPrompt: "Re-review again.\n",
        at: `2026-07-31T01:${String(round).padStart(2, "0")}:40.000Z`,
      });
      state = reduceState(state, {
        type: "dispatch-started",
        sessionId: `019fb673-4324-7c1d-98a2-3c638e29f85${String(round)}`,
        at: `2026-07-31T01:${String(round).padStart(2, "0")}:50.000Z`,
      });
      state = reduceState(state, {
        type: "rereview-finished",
        reportPath: `${RUN}/task-1-rereview-report.md`,
        specStatus: "FAIL",
        qualityStatus: "CHANGES_REQUESTED",
        at: `2026-07-31T01:${String(round).padStart(2, "0")}:55.000Z`,
      });
    }
    expect(state.fixRound).toBe(5);
    // Built without the helper: fixerTier itself rejects a sixth round, and the
    // reducer's cap must fire on its own rather than relying on that.
    expect(() =>
      reduceState(state, {
        type: "next-fix-dispatch-intended",
        role: "fixer",
        attempt: 1,
        dispatchKey: dispatchKeyFor({
          runId: ready().runId,
          task: 1,
          role: "fixer",
          attempt: 1,
          round: 6,
        }),
        tier: "capable",
        promptPath: `${RUN}/task-1-fix-6-prompt.md`,
        reportPath: `${RUN}/task-1-fix-6-report.md`,
        briefPath: `${RUN}/task-1-brief.md`,
        expectedOutcome: "fix-report",
        renderedPrompt: "Fix round 6.\n",
        at: "2026-07-31T02:00:00.000Z",
      }),
    ).toThrow(/capped at 5/u);
  });

  it("parks a contestable finding only with a persisted ruling", () => {
    const pinned = rereviewFinished({ findings: MINOR });
    const parked = reduceState(pinned, {
      type: "task-park-ruling-recorded",
      reason: "cosmetic; tracked separately",
      findingResolutions: [{ id: "F-2", disposition: "parked", evidence: "issue #412" }],
      at: "2026-07-31T00:15:00.000Z",
    });
    expect(parked.findings.find((f) => f.id === "F-2").disposition).toBe("parked");
  });

  it("never parks a load-bearing finding", () => {
    const pinned = reduceState(rereviewRunning(), {
      type: "rereview-finished",
      reportPath: `${RUN}/task-1-rereview-report.md`,
      specStatus: "FAIL",
      qualityStatus: "CHANGES_REQUESTED",
      findings: [{ id: "F-9", severity: "Critical", summary: "data loss on retry" }],
      at: "2026-07-31T00:14:00.000Z",
    });
    expect(() =>
      reduceState(pinned, {
        type: "task-park-ruling-recorded",
        reason: "deadline pressure",
        findingResolutions: [{ id: "F-9", disposition: "parked", evidence: "ship it" }],
        at: "2026-07-31T00:15:00.000Z",
      }),
    ).toThrow(/cannot be parked/u);
  });

  it("never silently drops a finding during adjudication", () => {
    const pinned = rereviewFinished({ findings: MINOR });
    expect(pinned.findings.map((f) => f.id).sort()).toEqual(["F-1", "F-2"]);
    const approved = reduceState(pinned, {
      type: "rereview-approved",
      findingResolutions: [{ id: "F-2", disposition: "out-of-scope", evidence: "separate module" }],
      at: "2026-07-31T00:15:00.000Z",
    });
    expect(approved.findings.map((f) => f.id).sort()).toEqual(["F-1", "F-2"]);
  });

  it("rejects a resolution naming an unknown finding", () => {
    const pinned = rereviewFinished();
    expect(() =>
      reduceState(pinned, {
        type: "rereview-approved",
        findingResolutions: [{ id: "F-404", disposition: "fixed", evidence: "invented" }],
        at: "2026-07-31T00:15:00.000Z",
      }),
    ).toThrow(/unknown finding/u);
  });

  it("requires evidence for every resolution", () => {
    const pinned = rereviewFinished({ findings: MINOR });
    expect(() =>
      reduceState(pinned, {
        type: "task-park-ruling-recorded",
        reason: "cosmetic",
        findingResolutions: [{ id: "F-2", disposition: "parked" }],
        at: "2026-07-31T00:15:00.000Z",
      }),
    ).toThrow(/evidence/u);
  });

  it("refuses to re-report a finding at a different severity", () => {
    expect(() =>
      reduceState(rereviewRunning(), {
        type: "rereview-finished",
        reportPath: `${RUN}/task-1-rereview-report.md`,
        specStatus: "FAIL",
        qualityStatus: "CHANGES_REQUESTED",
        findings: [{ id: "F-1", severity: "Minor", summary: "downgraded to dismiss it" }],
        at: "2026-07-31T00:14:00.000Z",
      }),
    ).toThrow(/cannot be re-reported/u);
  });
});

/** A single-task run reaching TASK_COMPLETE, ready for final review. */
const SOLO = Object.freeze({ tasks: [{ number: 1, implementerTier: "economy" }] });

const soloComplete = () => {
  const approved = reduceState(rereviewFinished(), {
    type: "rereview-approved",
    at: "2026-07-31T00:15:00.000Z",
  });
  expect(approved.phase).toBe("TASK_COMPLETE");
  // Re-pin onto the single-task index so task 1 is the last task and final
  // review becomes legal. Validated on the way through reduceState below.
  return { ...approved, tasks: SOLO.tasks };
};

const finalIntentEvent = (role, phaseLabel, overrides = {}) => ({
  role,
  attempt: 1,
  dispatchKey: dispatchKeyFor({ runId: ready().runId, task: 1, role, attempt: 1 }),
  tier: "frontier",
  promptPath: `${RUN}/${phaseLabel}-prompt.md`,
  reportPath: `${RUN}/${phaseLabel}-report.md`,
  briefPath: `${RUN}/task-1-brief.md`,
  expectedOutcome: `${phaseLabel}-report`,
  renderedPrompt: `${phaseLabel}\n`,
  ...overrides,
});

const finalReviewRunning = () => {
  const intent = reduceState(soloComplete(), {
    type: "final-review-dispatch-intended",
    ...finalIntentEvent("final", "final-review", { at: "2026-07-31T00:16:00.000Z" }),
  });
  expect(intent.phase).toBe("FINAL_REVIEW_DISPATCH_INTENT");
  return reduceState(intent, {
    type: "dispatch-started",
    sessionId: "019fb673-4324-7c1d-98a2-3c638e29f860",
    at: "2026-07-31T00:17:00.000Z",
  });
};

const finalReviewFinished = (overrides = {}) =>
  reduceState(finalReviewRunning(), {
    type: "final-review-finished",
    reportPath: `${RUN}/final-review-report.md`,
    specStatus: "PASS",
    qualityStatus: "APPROVED",
    at: "2026-07-31T00:18:00.000Z",
    ...overrides,
  });

describe("final review loop", () => {
  it("requires the last task to be complete before final review", () => {
    const twoTaskComplete = { ...soloComplete(), currentTask: 1, tasks: BASE_INIT.tasks };
    expect(twoTaskComplete.tasks).toHaveLength(2);
    expect(() =>
      reduceState(twoTaskComplete, {
        type: "final-review-dispatch-intended",
        ...finalIntentEvent("final", "final-review", { at: "2026-07-31T00:16:00.000Z" }),
      }),
    ).toThrow(/last task/u);
  });

  it("advances to the next task using only the immutable plan index", () => {
    const next = reduceState({ ...soloComplete(), tasks: BASE_INIT.tasks }, {
      type: "next-task-ready",
      at: "2026-07-31T00:16:00.000Z",
    });
    expect(next).toMatchObject({
      phase: "WORKSPACE_READY",
      currentTask: 2,
      currentImplementerTier: "advanced",
      contextAttempts: 0,
      fixRound: 0,
    });
  });

  it("requires every final role to run at frontier", () => {
    expect(() =>
      reduceState(soloComplete(), {
        type: "final-review-dispatch-intended",
        ...finalIntentEvent("final", "final-review", {
          tier: "capable",
          at: "2026-07-31T00:16:00.000Z",
        }),
      }),
    ).toThrow(/frontier/u);
  });

  it("records the final verdict without choosing a phase", () => {
    const state = finalReviewFinished();
    expect(state.phase).toBe("FINAL_REVIEW_RUNNING");
    expect(state.reviewOutcome.pinned).toBe(true);
  });

  it("completes a clean final review", () => {
    const done = reduceState(finalReviewFinished(), {
      type: "final-complete",
      at: "2026-07-31T00:19:00.000Z",
    });
    expect(done.phase).toBe("COMPLETE");
  });

  it("refuses completion before the final result is pinned", () => {
    expect(() =>
      reduceState(finalReviewRunning(), {
        type: "final-complete",
        at: "2026-07-31T00:19:00.000Z",
      }),
    ).toThrow(/recorded review result/u);
  });

  it("refuses completion while any finding is unadjudicated", () => {
    const withFinding = finalReviewFinished({
      findings: [{ id: "F-7", severity: "Minor", summary: "a stale comment" }],
    });
    expect(() =>
      reduceState(withFinding, { type: "final-complete", at: "2026-07-31T00:19:00.000Z" }),
    ).toThrow(/remain open/u);
  });

  it("permits exactly one final-fix wave", () => {
    const needsFix = finalReviewFinished({
      specStatus: "FAIL",
      qualityStatus: "CHANGES_REQUESTED",
      findings: [{ id: "F-8", severity: "Critical", summary: "a compatibility break" }],
    });
    let state = reduceState(needsFix, {
      type: "final-fix-dispatch-intended",
      ...finalIntentEvent("final-fixer", "final-fix", { at: "2026-07-31T00:19:00.000Z" }),
    });
    expect(state.phase).toBe("FINAL_FIX_DISPATCH_INTENT");
    expect(state.finalFixUsed).toBe(true);

    state = reduceState(state, {
      type: "dispatch-started",
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f870",
      at: "2026-07-31T00:20:00.000Z",
    });
    state = reduceState(state, {
      type: "final-rereview-dispatch-intended",
      ...finalIntentEvent("final-re-reviewer", "final-rereview", {
        at: "2026-07-31T00:21:00.000Z",
      }),
      findingResolutions: [{ id: "F-8", disposition: "fixed", evidence: "commit def5678" }],
    });
    state = reduceState(state, {
      type: "dispatch-started",
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f871",
      at: "2026-07-31T00:22:00.000Z",
    });
    state = reduceState(state, {
      type: "final-rereview-finished",
      reportPath: `${RUN}/final-rereview-report.md`,
      specStatus: "PASS",
      qualityStatus: "APPROVED",
      at: "2026-07-31T00:23:00.000Z",
    });
    const done = reduceState(state, { type: "final-complete", at: "2026-07-31T00:24:00.000Z" });
    expect(done.phase).toBe("COMPLETE");
    expect(done.findings.find((f) => f.id === "F-8").disposition).toBe("fixed");
  });

  it("refuses a second final-fix wave", () => {
    const used = { ...finalReviewFinished({ specStatus: "FAIL" }), finalFixUsed: true };
    expect(() =>
      reduceState(used, {
        type: "final-fix-dispatch-intended",
        ...finalIntentEvent("final-fixer", "final-fix", { at: "2026-07-31T00:19:00.000Z" }),
      }),
    ).toThrow(/exactly one final-fix wave/u);
  });

  it("blocks a load-bearing residual at final re-review", () => {
    const blocked = reduceState(
      finalReviewFinished({
        specStatus: "FAIL",
        findings: [{ id: "F-6", severity: "Critical", summary: "unsafe migration" }],
      }),
      { type: "final-blocked", reason: "unsafe migration must be fixed", at: "2026-07-31T00:19:00.000Z" },
    );
    expect(blocked.phase).toBe("FINAL_BLOCKED");
  });

  it("accepts no continuation event once terminal", () => {
    const done = reduceState(finalReviewFinished(), {
      type: "final-complete",
      at: "2026-07-31T00:19:00.000Z",
    });
    expect(() =>
      reduceState(done, { type: "next-task-ready", at: "2026-07-31T00:20:00.000Z" }),
    ).toThrow(/terminal/u);
  });
});

describe("recovery rulings", () => {
  it("records a repair in any nonterminal phase without changing it", () => {
    const before = ready();
    const after = reduceState(before, {
      type: "recovery-ruling-recorded",
      reason: "cleared a stale lock from a dead PID",
      receipt: "lock-token 4f2a released at 00:03:10Z",
      at: "2026-07-31T00:03:10.000Z",
    });
    expect(after.phase).toBe(before.phase);
    expect(after.recoveryRulings).toBe(1);
    expect(after.revision).toBe(before.revision + 1);
  });

  it("requires a receipt, not just a reason", () => {
    expect(() =>
      reduceState(ready(), {
        type: "recovery-ruling-recorded",
        reason: "cleared a lock",
        at: "2026-07-31T00:03:10.000Z",
      }),
    ).toThrow(/receipt/u);
  });

  it("is not legal in a terminal phase", () => {
    const blocked = reduceState(init(), {
      type: "capability-missing",
      reason: "get_model_policy unavailable",
      at: "2026-07-31T00:01:00.000Z",
    });
    expect(() =>
      reduceState(blocked, {
        type: "recovery-ruling-recorded",
        reason: "retry",
        receipt: "none",
        at: "2026-07-31T00:02:00.000Z",
      }),
    ).toThrow(/terminal/u);
  });
});

describe("reducer completeness", () => {
  it("registers every phase/event pair exactly once", () => {
    const seen = new Set(TRANSITIONS.map((entry) => `${entry.phase}\u0000${entry.event}`));
    expect(seen.size).toBe(TRANSITIONS.length);
  });

  it("registers only known phases", () => {
    for (const { phase } of TRANSITIONS) expect(PHASES).toContain(phase);
  });

  it("gives every nonterminal phase at least one outgoing transition", () => {
    const withOutgoing = new Set(TRANSITIONS.map((entry) => entry.phase));
    const stranded = PHASES.filter(
      (phase) => !withOutgoing.has(phase) && !TERMINAL_PHASES.includes(phase),
    );
    expect(stranded).toEqual([]);
  });

  it("gives terminal phases no outgoing transition", () => {
    const withOutgoing = new Set(TRANSITIONS.map((entry) => entry.phase));
    expect(TERMINAL_PHASES.filter((phase) => withOutgoing.has(phase))).toEqual([]);
  });

  it("rejects every unregistered event name", () => {
    expect(() =>
      reduceState(ready(), { type: "definitely-not-an-event", at: "2026-07-31T00:03:00.000Z" }),
    ).toThrow(/unknown event type/u);
  });

  it("reaches every gate phase through the production order", () => {
    const gated = reduceState(init(SOLO), {
      type: "capability-confirmed",
      mode: "tiered",
      at: "2026-07-31T00:01:00.000Z",
    });
    expect(gated.phase).toBe("PLAN_VALIDATE");
    const validated = reduceState(gated, {
      type: "plan-valid",
      planDigest: BASE_INIT.planDigest,
      at: "2026-07-31T00:02:00.000Z",
    });
    const conflicted = reduceState(validated, {
      type: "preflight-conflict",
      reason: "untracked build output",
      at: "2026-07-31T00:02:30.000Z",
    });
    const approved = reduceState(conflicted, {
      type: "preflight-approved",
      reason: "generated files only",
      at: "2026-07-31T00:02:40.000Z",
    });
    expect(approved.phase).toBe("WORKSPACE_READY");
  });
});

describe("state-machine reference stays in step with the reducer", () => {
  const reference = readFileSync(
    new URL("../references/state-machine.md", import.meta.url),
    "utf8",
  );

  it("names every phase the reducer declares", () => {
    const missing = PHASES.filter((phase) => !reference.includes(`\`${phase}\``));
    expect(missing).toEqual([]);
  });

  it("names every event the reducer accepts", () => {
    const events = [...new Set(TRANSITIONS.map((entry) => entry.event))];
    const missing = events.filter((event) => !reference.includes(`\`${event}\``));
    expect(missing).toEqual([]);
  });

  it("names no phase the reducer does not declare", () => {
    // Status tokens and exported identifiers share the SHOUTY shape but are not
    // phases; listing them keeps a genuinely unknown phase name failing.
    const notPhases = [
      "TRANSITIONS",
      "PHASES",
      "EVENT_TYPES",
      "TERMINAL_PHASES",
      "PASS",
      "FAIL",
      "APPROVED",
      "CHANGES_REQUESTED",
      "DONE",
      "DONE_WITH_CONCERNS",
      "NEEDS_CONTEXT",
      "BLOCKED",
    ];
    const cited = [...reference.matchAll(/`([A-Z][A-Z_]{3,})`/gu)].map((match) => match[1]);
    const unknown = [...new Set(cited)].filter(
      (token) => !PHASES.includes(token) && !notPhases.includes(token),
    );
    expect(unknown).toEqual([]);
  });

  it("reports the transition and phase counts the reducer actually has", () => {
    expect(reference).toContain(`${String(TRANSITIONS.length)} registered`);
    expect(reference.toLowerCase()).toContain(`${String(PHASES.length)} phases`);
  });

  it("states the canonical direction of truth", () => {
    expect(reference).toMatch(/`state\.json` is canonical/u);
    expect(reference).toMatch(/never hand-edit/iu);
  });
});

/**
 * Build a real run directory with a real plan file on disk.
 *
 * The store is exercised through the CLI against a real filesystem, because the
 * properties under test are atomicity, locking, and fsync ordering. A mocked
 * filesystem would assert the mock.
 */
function makeRun({ plan = VALID_PLAN } = {}) {
  const root = makeTemporaryDirectory();
  const worktree = join(root, "wt");
  const runRoot = join(worktree, ".superpowers", "sdd", "plan-abc12345");
  mkdirSync(runRoot, { recursive: true });
  const planPath = join(worktree, "plan.md");
  writeFileSync(planPath, plan);
  return {
    root,
    worktree,
    runRoot,
    planPath,
    statePath: join(runRoot, "state.json"),
    progressPath: join(runRoot, "progress.md"),
    planDigest: createHash("sha256").update(plan).digest("hex"),
  };
}

const MERGE_BASE = "b".repeat(40);

function initArgs(run, overrides = {}) {
  const merged = {
    plan: run.planPath,
    state: run.statePath,
    progress: run.progressPath,
    "repo-root": run.worktree,
    worktree: run.worktree,
    branch: "feature/example",
    "base-ref": "main",
    "merge-base": MERGE_BASE,
    ...overrides,
  };
  return ["init", ...Object.entries(merged).flatMap(([key, value]) => [`--${key}`, value])];
}

/** Write a bounded event JSON file under the run root, as the CLI requires. */
function writeEvent(run, event, name = "event.json") {
  const path = join(run.runRoot, name);
  writeFileSync(path, JSON.stringify(event));
  return path;
}

const readState = (run) => JSON.parse(readFileSync(run.statePath, "utf8"));
const countMarkers = (run) =>
  readFileSync(run.progressPath, "utf8").split("\n").filter((line) => line.includes("sdd-transition:")).length;

describe("state store init", () => {
  it("writes revision 0 plus exactly one audit marker", () => {
    const run = makeRun();
    const result = runCli(initArgs(run));
    expect(result.status).toBe(0);

    const state = readState(run);
    expect(state).toMatchObject({ version: 1, revision: 0, phase: "CAPABILITY_CHECK" });
    expect(state.planDigest).toBe(run.planDigest);
    expect(state.tasks).toHaveLength(2);
    expect(countMarkers(run)).toBe(1);
  });

  it("refuses to initialize twice", () => {
    const run = makeRun();
    expect(runCli(initArgs(run)).status).toBe(0);
    const second = runCli(initArgs(run));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already/iu);
    expect(readState(run).revision).toBe(0);
    expect(countMarkers(run)).toBe(1);
  });

  it("rejects a plan the parser will not accept", () => {
    const run = makeRun({ plan: "# Plan\n\n### Task 1: H3 heading\n\nBody.\n" });
    const result = runCli(initArgs(run));
    expect(result.status).toBe(2);
    expect(existsSync(run.statePath)).toBe(false);
  });
});

describe("state store transition", () => {
  const confirmed = { type: "capability-confirmed", mode: "tiered" };

  it("advances revision 0 to 1 and appends one marker", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, confirmed);

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ]);
    expect(result.status).toBe(0);
    expect(readState(run)).toMatchObject({ revision: 1, phase: "PLAN_VALIDATE" });
    expect(countMarkers(run)).toBe(2);
  });

  it("leaves both files untouched on a stale expected revision", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, confirmed);
    const before = readFileSync(run.statePath);
    const beforeProgress = readFileSync(run.progressPath);

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "7",
      "--event-file",
      eventPath,
    ]);
    expect(result.status).toBe(3);
    expect(readFileSync(run.statePath)).toEqual(before);
    expect(readFileSync(run.progressPath)).toEqual(beforeProgress);
  });

  it("rejects an illegal transition without writing", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, { type: "final-complete" });
    const before = readFileSync(run.statePath);

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ]);
    expect(result.status).toBe(2);
    expect(readFileSync(run.statePath)).toEqual(before);
  });

  it("fails closed when the plan digest drifts under the run", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeFileSync(run.planPath, `${VALID_PLAN}\n<!-- edited after init -->\n`);
    const eventPath = writeEvent(run, confirmed);

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ]);
    expect(result.status).toBe(4);
    expect(result.stderr).toMatch(/digest/iu);
    expect(readState(run).revision).toBe(0);
  });

  it("rejects a caller-supplied transition timestamp", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, { ...confirmed, at: "2030-01-01T00:00:00.000Z" });

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/timestamp|\bat\b/iu);
  });

  it("requires the event file to live under the run root", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const outside = join(run.root, "outside-event.json");
    writeFileSync(outside, JSON.stringify(confirmed));

    const result = runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      outside,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/run root/iu);
  });

  it("serializes two concurrent transitions into one winner", async () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, confirmed);
    const args = [
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ];

    const results = await Promise.all([
      new Promise((done) => {
        const child = spawn(CLI, args, { stdio: "ignore" });
        child.on("exit", (code) => done(code));
      }),
      new Promise((done) => {
        const child = spawn(CLI, args, { stdio: "ignore" });
        child.on("exit", (code) => done(code));
      }),
    ]);

    expect(results.filter((code) => code === 0)).toHaveLength(1);
    expect(results.filter((code) => code === 3)).toHaveLength(1);
    expect(readState(run).revision).toBe(1);
    expect(countMarkers(run)).toBe(2);
  });
});

describe("state store show", () => {
  it("is read-only, byte for byte", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const before = readFileSync(run.statePath);
    const beforeProgress = readFileSync(run.progressPath);

    const result = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).state.revision).toBe(0);
    expect(readFileSync(run.statePath)).toEqual(before);
    expect(readFileSync(run.progressPath)).toEqual(beforeProgress);
  });

  it("reports a missing final marker as repairable", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeFileSync(run.progressPath, "# SDD ledger\n");

    const result = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout).audit).toMatchObject({ status: "AUDIT_REPAIR_NEEDED" });
  });
});

/** Drive a run to IMPLEMENT_DISPATCH_INTENT through the real CLI. */
function runToIntent(run) {
  runCli(initArgs(run));
  const step = (event, expectedRevision, name) =>
    runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      String(expectedRevision),
      "--event-file",
      writeEvent(run, event, name),
    ]);

  expect(step({ type: "capability-confirmed", mode: "tiered" }, 0, "e0.json").status).toBe(0);
  expect(step({ type: "plan-valid", planDigest: run.planDigest }, 1, "e1.json").status).toBe(0);
  expect(step({ type: "preflight-clean" }, 2, "e2.json").status).toBe(0);

  const state = readState(run);
  const intent = {
    type: "implement-dispatch-intended",
    role: "implementer",
    attempt: 1,
    dispatchKey: `${state.runId}:task-1:implementer:attempt-1`,
    tier: state.currentImplementerTier,
    promptPath: join(run.runRoot, "task-1-prompt.md"),
    reportPath: join(run.runRoot, "task-1-report.md"),
    briefPath: join(run.runRoot, "task-1-brief.md"),
    expectedOutcome: "implementer-report",
    renderedPrompt: "Implement task 1 exactly.\n",
  };
  expect(step(intent, 3, "e3.json").status).toBe(0);
  return intent;
}

describe("audit repair", () => {
  it("appends exactly one missing marker under the lock", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const eventPath = writeEvent(run, { type: "capability-confirmed", mode: "tiered" });
    runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      "0",
      "--event-file",
      eventPath,
    ]);
    expect(countMarkers(run)).toBe(2);

    // Drop the final marker, simulating a crash between state rename and append.
    const lines = readFileSync(run.progressPath, "utf8").split("\n");
    const lastMarker = lines.findLastIndex((line) => line.includes("sdd-transition:"));
    writeFileSync(run.progressPath, [...lines.slice(0, lastMarker), ...lines.slice(lastMarker + 1)].join("\n"));
    expect(countMarkers(run)).toBe(1);

    const stateBefore = readFileSync(run.statePath);
    const repair = runCli([
      "repair-audit",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
    ]);
    expect(repair.status).toBe(0);
    expect(JSON.parse(repair.stdout)).toMatchObject({ repaired: true, markers: 2 });
    expect(countMarkers(run)).toBe(2);
    // Repair projects only lastTransition; canonical state is untouched.
    expect(readFileSync(run.statePath)).toEqual(stateBefore);
  });

  it("is a no-op when the ledger is already complete", () => {
    const run = makeRun();
    runCli(initArgs(run));
    const repair = runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]);
    expect(repair.status).toBe(0);
    expect(JSON.parse(repair.stdout)).toMatchObject({ repaired: false });
    expect(countMarkers(run)).toBe(1);
  });

  it("treats a ledger ahead of state as corruption, not a missing marker", () => {
    const run = makeRun();
    runCli(initArgs(run));
    appendFileSync(run.progressPath, "<!-- sdd-transition: revision=9 phase=COMPLETE -->\n");
    const repair = runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]);
    expect(repair.status).toBe(4);
    expect(repair.stderr).toMatch(/corruption/iu);
  });

  it("appends once when two repairs race", async () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeFileSync(run.progressPath, "# SDD ledger\n");
    const args = ["repair-audit", "--state", run.statePath, "--progress", run.progressPath];

    const codes = await Promise.all(
      [0, 1].map(
        () =>
          new Promise((done) => {
            spawn(CLI, args, { stdio: "ignore" }).on("exit", (code) => done(code));
          }),
      ),
    );
    expect(codes.filter((code) => code === 0).length).toBeGreaterThanOrEqual(1);
    expect(countMarkers(run)).toBe(1);
  });
});

describe("lock handling", () => {
  const lockPath = (run) => `${run.statePath}.lock`;

  const writeLock = (run, owner) => writeFileSync(lockPath(run), `${JSON.stringify(owner)}\n`);

  it("reports an unlocked run", () => {
    const run = makeRun();
    runCli(initArgs(run));
    expect(JSON.parse(runCli(["lock-status", "--state", run.statePath]).stdout)).toMatchObject({
      status: "UNLOCKED",
    });
  });

  it("reports a live lock and refuses repair while it is held", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeFileSync(run.progressPath, "# SDD ledger\n");
    writeLock(run, {
      token: "live-token",
      pid: process.pid,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    });

    expect(JSON.parse(runCli(["lock-status", "--state", run.statePath]).stdout).status).toBe("LIVE");
    const show = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(JSON.parse(show.stdout).audit.status).toBe("RUN_LOCKED");
    expect(show.status).toBe(0);

    const repair = runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]);
    expect(repair.status).toBe(3);
    // The liveness guard fires before lock acquisition, so the message names why
    // repair is unsafe rather than reporting a generic contention.
    expect(repair.stderr).toMatch(/not safe while a transition may be live/u);
    expect(countMarkers(run)).toBe(0);
  });

  it("requires a stale lock to be cleared before repair can proceed", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeFileSync(run.progressPath, "# SDD ledger\n");
    const owner = {
      token: "dead-token",
      pid: 2 ** 22,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    };
    writeFileSync(`${run.statePath}.lock`, `${JSON.stringify(owner)}\n`);

    // A stale lock still blocks acquisition, so recovery is ordered:
    // clear-stale-lock first, then repair-audit.
    const blocked = runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]);
    expect(blocked.status).toBe(3);
    expect(countMarkers(run)).toBe(0);

    const decisionPath = join(run.runRoot, "stale-decision.json");
    writeFileSync(
      decisionPath,
      JSON.stringify({
        action: "clear-stale-lock",
        ownerToken: "dead-token",
        reason: "the controller was killed mid-transition",
        approvedAt: "2026-07-31T01:00:00.000Z",
      }),
    );
    expect(
      runCli([
        "clear-stale-lock",
        "--state",
        run.statePath,
        "--expected-owner-token",
        "dead-token",
        "--decision-file",
        decisionPath,
      ]).status,
    ).toBe(0);

    const repaired = runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]);
    expect(repaired.status).toBe(0);
    expect(countMarkers(run)).toBe(1);
  });

  it("reports a dead owner as stale without clearing it", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeLock(run, {
      token: "dead-token",
      pid: 2 ** 22,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    });
    expect(JSON.parse(runCli(["lock-status", "--state", run.statePath]).stdout).status).toBe("STALE");
    expect(existsSync(lockPath(run))).toBe(true);
  });

  it("clears a stale lock only with a matching token and persisted decision", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeLock(run, {
      token: "dead-token",
      pid: 2 ** 22,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    });
    const decisionPath = join(run.runRoot, "decision.json");
    writeFileSync(
      decisionPath,
      JSON.stringify({
        action: "clear-stale-lock",
        ownerToken: "dead-token",
        reason: "the controller host rebooted",
        approvedAt: "2026-07-31T01:00:00.000Z",
      }),
    );

    const wrongToken = runCli([
      "clear-stale-lock",
      "--state",
      run.statePath,
      "--expected-owner-token",
      "not-the-token",
      "--decision-file",
      decisionPath,
    ]);
    expect(wrongToken.status).toBe(6);
    expect(existsSync(lockPath(run))).toBe(true);

    const cleared = runCli([
      "clear-stale-lock",
      "--state",
      run.statePath,
      "--expected-owner-token",
      "dead-token",
      "--decision-file",
      decisionPath,
    ]);
    expect(cleared.status).toBe(0);
    expect(JSON.parse(cleared.stdout).receipt).toMatch(/dead-token|dead pid/u);
    expect(existsSync(lockPath(run))).toBe(false);
  });

  it("never clears a lock whose owner is alive", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeLock(run, {
      token: "live-token",
      pid: process.pid,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    });
    const decisionPath = join(run.runRoot, "decision.json");
    writeFileSync(
      decisionPath,
      JSON.stringify({
        action: "clear-stale-lock",
        ownerToken: "live-token",
        reason: "impatience",
        approvedAt: "2026-07-31T01:00:00.000Z",
      }),
    );
    const result = runCli([
      "clear-stale-lock",
      "--state",
      run.statePath,
      "--expected-owner-token",
      "live-token",
      "--decision-file",
      decisionPath,
    ]);
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/still alive/iu);
    expect(existsSync(lockPath(run))).toBe(true);
  });

  it("requires a decision file naming the clear-stale-lock action", () => {
    const run = makeRun();
    runCli(initArgs(run));
    writeLock(run, {
      token: "dead-token",
      pid: 2 ** 22,
      host: hostname(),
      at: "2026-07-31T00:00:00.000Z",
    });
    const decisionPath = join(run.runRoot, "decision.json");
    writeFileSync(
      decisionPath,
      JSON.stringify({
        action: "do-whatever",
        ownerToken: "dead-token",
        reason: "wrong action",
        approvedAt: "2026-07-31T01:00:00.000Z",
      }),
    );
    expect(
      runCli([
        "clear-stale-lock",
        "--state",
        run.statePath,
        "--expected-owner-token",
        "dead-token",
        "--decision-file",
        decisionPath,
      ]).status,
    ).toBe(2);
    expect(existsSync(lockPath(run))).toBe(true);
  });
});

describe("crash recovery across the spawn window", () => {
  const transitionAt = (run, event, revision, name) =>
    runCli([
      "transition",
      "--state",
      run.statePath,
      "--progress",
      run.progressPath,
      "--plan",
      run.planPath,
      "--expected-revision",
      String(revision),
      "--event-file",
      writeEvent(run, event, name),
    ]);

  it("preserves the intent verbatim when the process dies before correlation", () => {
    const run = makeRun();
    const intent = runToIntent(run);

    // Simulate the crash: nothing recorded the session id. A fresh process reads
    // only what is on disk.
    const inspected = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(inspected.status).toBe(0);
    const report = JSON.parse(inspected.stdout);

    expect(report.state.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(report.dispatch).toMatchObject({
      dispatchKey: intent.dispatchKey,
      role: "implementer",
      tier: intent.tier,
      sessionId: null,
      ambiguous: true,
    });
    expect(report.state.dispatch.renderedPrompt).toBe(intent.renderedPrompt);
    expect(report.nextAction).toMatch(/adopt an observed session id, or reissue/u);
  });

  it("reconstructs a reissue from stored state alone, with no renderer call", () => {
    const run = makeRun();
    const intent = runToIntent(run);
    const report = JSON.parse(
      runCli(["show", "--state", run.statePath, "--progress", run.progressPath]).stdout,
    );

    // Byte-for-byte, including the trailing newline. Recovery never re-renders,
    // because re-rendering couples recovery to renderer output.
    const recovered = report.state.dispatch.renderedPrompt;
    expect(recovered).toBe(intent.renderedPrompt);
    expect(Buffer.byteLength(recovered, "utf8")).toBe(
      Buffer.byteLength(intent.renderedPrompt, "utf8"),
    );
    expect(report.dispatch.renderedPromptBytes).toBe(
      Buffer.byteLength(intent.renderedPrompt, "utf8"),
    );

    // Everything a reissue needs is present on disk: prompt bytes, cwd root, and
    // the typed tier that binds the model.
    expect(report.state.runRoot).toBe(run.runRoot);
    expect(report.state.dispatch.tier).toBe(intent.tier);
  });

  it("surfaces the crossed window and refuses to resolve it implicitly", () => {
    const run = makeRun();
    runToIntent(run);

    const crossed = transitionAt(
      run,
      { type: "dispatch-window-crossed", reason: "controller restarted before correlation" },
      4,
      "crossed.json",
    );
    expect(crossed.status).toBe(0);
    expect(readState(run).phase).toBe("DISPATCH_AMBIGUOUS");

    // A plain correlation is not a ruling. The reducer refuses it.
    const implicit = transitionAt(
      run,
      { type: "dispatch-started", sessionId: "sess-guessed" },
      5,
      "implicit.json",
    );
    expect(implicit.status).toBe(2);
    expect(implicit.stderr).toMatch(/illegal transition/u);
    expect(readState(run).phase).toBe("DISPATCH_AMBIGUOUS");
  });

  it("records adopt and reissue as distinct, durable outcomes", () => {
    const adoptRun = makeRun();
    runToIntent(adoptRun);
    transitionAt(
      adoptRun,
      { type: "dispatch-window-crossed", reason: "restart" },
      4,
      "crossed.json",
    );
    expect(
      transitionAt(
        adoptRun,
        {
          type: "dispatch-ruling-recorded",
          decision: "adopt",
          sessionId: "sess-observed-child",
          reason: "one child observed with the matching cwd",
        },
        5,
        "adopt.json",
      ).status,
    ).toBe(0);
    const adopted = readState(adoptRun);
    expect(adopted.phase).toBe("IMPLEMENT_RUNNING");
    expect(adopted.dispatch.sessionId).toBe("sess-observed-child");
    expect(adopted.dispatch.reissued).toBe(false);

    const reissueRun = makeRun();
    const intent = runToIntent(reissueRun);
    transitionAt(
      reissueRun,
      { type: "dispatch-window-crossed", reason: "restart" },
      4,
      "crossed.json",
    );
    expect(
      transitionAt(
        reissueRun,
        {
          type: "dispatch-ruling-recorded",
          decision: "reissue",
          reason: "no child found; accepting a possible orphan",
        },
        5,
        "reissue.json",
      ).status,
    ).toBe(0);
    const reissued = readState(reissueRun);
    expect(reissued.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(reissued.dispatch.sessionId).toBeNull();
    expect(reissued.dispatch.reissued).toBe(true);
    // The bytes survived the whole detour untouched.
    expect(reissued.dispatch.renderedPrompt).toBe(intent.renderedPrompt);
  });

  it("keeps show read-only across a full repair cycle", () => {
    const run = makeRun();
    runToIntent(run);
    const stateBefore = readFileSync(run.statePath);

    const lines = readFileSync(run.progressPath, "utf8").split("\n");
    const last = lines.findLastIndex((line) => line.includes("sdd-transition:"));
    writeFileSync(run.progressPath, [...lines.slice(0, last), ...lines.slice(last + 1)].join("\n"));

    const before = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(before.status).toBe(5);
    expect(readFileSync(run.statePath)).toEqual(stateBefore);

    expect(
      runCli(["repair-audit", "--state", run.statePath, "--progress", run.progressPath]).status,
    ).toBe(0);
    const after = runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);
    expect(after.status).toBe(0);
    expect(JSON.parse(after.stdout).audit.status).toBe("OK");
    expect(readFileSync(run.statePath)).toEqual(stateBefore);
  });

  it("records the recovery receipt without changing the phase", () => {
    const run = makeRun();
    runToIntent(run);
    const before = readState(run);

    const recorded = transitionAt(
      run,
      {
        type: "recovery-ruling-recorded",
        reason: "cleared a stale lock from a dead controller",
        receipt: "cleared lock token 4f2a held by dead pid 9999",
      },
      4,
      "recovery.json",
    );
    expect(recorded.status).toBe(0);

    const after = readState(run);
    expect(after.phase).toBe(before.phase);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.recoveryRulings).toBe(1);
  });

  it("leaves no stale temp or lock files behind", () => {
    const run = makeRun();
    runToIntent(run);
    runCli(["show", "--state", run.statePath, "--progress", run.progressPath]);

    const leftovers = readdirSync(run.runRoot).filter(
      (name) => name.includes(".tmp.") || name.endsWith(".lock"),
    );
    expect(leftovers).toEqual([]);
  });
});

/**
 * Manifest validation rejections.
 *
 * The manifest-content tests in `sdd-scripts.test.mjs` assert properties of the
 * generated manifest, which the real runtime list never violates -- so removing a
 * guard left them all passing. These feed the validator the inputs the guards
 * exist for, so each rejection is pinned by a test that fails when it is removed.
 */
describe("manifest validation", () => {
  const SOURCE_ROOT = join(import.meta.dirname, "..");
  const PACKAGE_JSON = join(SOURCE_ROOT, "..", "..", "package.json");

  it("rejects a runtime entry that escapes the source root", () => {
    expect(() => assertRuntimeList(["../package.json"])).toThrow(ManifestError);
    expect(() => assertRuntimeList(["SKILL.md", "nested/../../escape.md"])).toThrow(
      /normalized path/u,
    );
    // Traversal is refused during list validation, before any path is resolved.
    expect(() => computeRuntimeHash(join(SOURCE_ROOT, "scripts"), ["lib/../../SKILL.md"])).toThrow(
      /normalized path/u,
    );
  });

  it("rejects an absolute or backslash-separated runtime entry", () => {
    expect(() => assertRuntimeList(["/etc/passwd"])).toThrow(/must be relative/u);
    expect(() => assertRuntimeList(["scripts\\lib\\manifest.mjs"])).toThrow(/forward slashes/u);
  });

  it("rejects development evidence in the runtime list", () => {
    expect(() => assertRuntimeList(["SKILL.md", "evals/evals.json"])).toThrow(
      /must not ship development evidence/u,
    );
    expect(() => assertRuntimeList(["SKILL.md", "tests/sdd-state.test.mjs"])).toThrow(
      /must not ship development evidence/u,
    );
  });

  it("rejects a duplicated or unsorted runtime list", () => {
    expect(() => assertRuntimeList(["SKILL.md", "SKILL.md"])).toThrow(/duplicate/u);
    expect(() => assertRuntimeList(["prompts/implementer.md", "SKILL.md"])).toThrow(/sorted/u);
  });

  it("rejects an empty or non-array runtime list", () => {
    expect(() => assertRuntimeList([])).toThrow(/non-empty array/u);
    expect(() => assertRuntimeList("SKILL.md")).toThrow(/non-empty array/u);
    expect(() => assertRuntimeList([""])).toThrow(/non-empty strings/u);
  });

  it("rejects a source package whose version is not semver", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-manifest-pkg-"));
    temporaryRoots.push(root);
    const write = (value) => {
      const path = join(root, "package.json");
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    expect(() =>
      buildManifest({
        sourceRoot: SOURCE_ROOT,
        packageJsonPath: write({ name: "@scope/pkg", version: "1.2" }),
      }),
    ).toThrow(/not valid semver/u);
    expect(() =>
      buildManifest({
        sourceRoot: SOURCE_ROOT,
        packageJsonPath: write({ name: "@scope/pkg", version: "v1.2.3" }),
      }),
    ).toThrow(/not valid semver/u);
    expect(() =>
      buildManifest({ sourceRoot: SOURCE_ROOT, packageJsonPath: write({ version: "1.2.3" }) }),
    ).toThrow(/no name/u);
    // A prerelease version is legitimate: this package ships beta tags.
    expect(
      buildManifest({
        sourceRoot: SOURCE_ROOT,
        packageJsonPath: write({ name: "@scope/pkg", version: "1.11.0-beta.2" }),
      }).sourcePackage.version,
    ).toBe("1.11.0-beta.2");
  });

  it("names a missing runtime file rather than surfacing a raw filesystem error", () => {
    expect(() => computeRuntimeHash(SOURCE_ROOT, ["SKILL.md", "absent-file.md"])).toThrow(
      /runtime file is missing: absent-file\.md/u,
    );
  });

  it("orders path bytes before file bytes so a rename changes the digest", () => {
    const root = mkdtempSync(join(tmpdir(), "sdd-manifest-hash-"));
    temporaryRoots.push(root);
    writeFileSync(join(root, "a.md"), "same");
    writeFileSync(join(root, "b.md"), "same");
    // Identical contents under different names must not collide.
    expect(computeRuntimeHash(root, ["a.md"])).not.toBe(computeRuntimeHash(root, ["b.md"]));
    // And the delimiter must prevent path/content bytes from being interchangeable.
    writeFileSync(join(root, "ab.md"), "");
    writeFileSync(join(root, "a.md"), "b.md");
    expect(computeRuntimeHash(root, ["a.md"])).not.toBe(computeRuntimeHash(root, ["ab.md"]));
  });

  it("builds a manifest whose recorded package matches the real root package", () => {
    const manifest = buildManifest({ sourceRoot: SOURCE_ROOT, packageJsonPath: PACKAGE_JSON });
    expect(manifest.name).toBe("deterministic-subagent-driven-development");
    expect(manifest.distribution).toBe("opt-in");
    expect(manifest.sourcePackage.name).toBe("@hyperdreamer/pi-webui");
    expect(manifest.runtimeHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
