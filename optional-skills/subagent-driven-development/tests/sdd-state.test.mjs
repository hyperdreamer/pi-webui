import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createInitialState,
  dispatchKeyFor,
  fixerTier,
  parsePlanText,
  reReviewerTier,
  reviewerTier,
  reduceState,
  roleTier,
  tierDirective,
  tierLabel,
  TIERS,
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
    it("resolves each role and emits the matching directive", () => {
      expect(roleTier({ implementer: "advanced", role: "implementer" }))
        .toEqual({ tier: "advanced", directive: "/tier-advanced" });
      expect(roleTier({ implementer: "advanced", role: "task-reviewer" }))
        .toEqual({ tier: "capable", directive: "/tier-capable" });
      expect(roleTier({ implementer: "advanced", role: "re-reviewer" }))
        .toEqual({ tier: "capable", directive: "/tier-capable" });
      expect(roleTier({ implementer: "advanced", role: "final" }))
        .toEqual({ tier: "frontier", directive: "/tier-frontier" });
      expect(roleTier({ implementer: "advanced", role: "fixer", round: 4 }))
        .toEqual({ tier: "capable", directive: "/tier-capable" });
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

const CLI = "optional-skills/subagent-driven-development/scripts/sdd-state";
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
      [["--implementer", "advanced", "--role", "implementer"], "advanced", "/tier-advanced"],
      [["--implementer", "advanced", "--role", "task-reviewer"], "capable", "/tier-capable"],
      [["--implementer", "advanced", "--role", "re-reviewer"], "capable", "/tier-capable"],
      [["--implementer", "advanced", "--role", "final"], "frontier", "/tier-frontier"],
      [["--implementer", "advanced", "--role", "fixer", "--round", "4"], "capable", "/tier-capable"],
      [["--implementer", "economy", "--role", "task-reviewer"], "standard", "/tier-standard"],
    ];
    for (const [args, tier, directive] of expectations) {
      const result = runCli(["role-tier", ...args]);
      expect(result.status, `${args.join(" ")} -> ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ tier, directive });
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
          'const m = await import("./optional-skills/subagent-driven-development/scripts/sdd-state.mjs");',
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

  it("emits a lowercase directive echo", () => {
    expect(tierDirective("capable")).toBe("/tier-capable");
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
    expect(next.phase).toBe("PLAN_CHECK");
  });

  it("accepts a valid exact-mode capability", () => {
    const next = reduceState(init(), {
      type: "capability-confirmed",
      mode: "exact",
      at,
    });
    expect(next.phase).toBe("PLAN_CHECK");
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

  it("requires a persisted ruling to leave a preflight decision", () => {
    const gated = reduceState(init(), { type: "capability-confirmed", mode: "tiered", at });
    const valid = reduceState(gated, { type: "plan-valid", planDigest: BASE_INIT.planDigest, at });
    const pending = reduceState(valid, {
      type: "preflight-decision-required",
      reason: "worktree is dirty",
      at,
    });
    expect(pending.phase).toBe("PREFLIGHT_DECISION_REQUIRED");
    expect(() => reduceState(pending, { type: "plan-valid", planDigest: BASE_INIT.planDigest, at })).toThrow(
      /illegal transition/u,
    );
    expect(
      reduceState(pending, {
        type: "preflight-ruling-recorded",
        decision: "proceed",
        reason: "generated files only",
        at,
      }).phase,
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
  return reduceState(gated, {
    type: "plan-valid",
    planDigest: BASE_INIT.planDigest,
    at: "2026-07-31T00:02:00.000Z",
  });
};

const RUN = BASE_INIT.runRoot;
const at3 = "2026-07-31T00:03:00.000Z";
const at4 = "2026-07-31T00:04:00.000Z";
const at5 = "2026-07-31T00:05:00.000Z";

const intentEvent = (overrides = {}) => ({
  type: "dispatch-intended",
  role: "implementer",
  dispatchKey: dispatchKeyFor({
    runId: ready().runId,
    task: 1,
    role: "implementer",
    attempt: 1,
  }),
  tier: "economy",
  promptPath: `${RUN}/task-1-implementer-prompt.md`,
  reportPath: `${RUN}/task-1-implementer-report.md`,
  briefPath: `${RUN}/task-1-brief.md`,
  attempt: 1,
  expectedOutcome: "implementer-report",
  renderedPrompt: "Implement task 1.\n",
  at: at3,
  ...overrides,
});

const intended = (overrides = {}) => reduceState(ready(), intentEvent(overrides));

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

  it("accepts a rendered prompt with no leading tier directive", () => {
    expect(intended({ renderedPrompt: "No directive at all.\n" }).dispatch.renderedPrompt).toBe(
      "No directive at all.\n",
    );
  });

  it("accepts a leading directive echo that agrees with the typed tier", () => {
    expect(
      intended({ renderedPrompt: "/tier-economy\n\nImplement task 1.\n" }).dispatch.tier,
    ).toBe("economy");
  });

  it("reports a leading directive echo that disagrees with the typed tier", () => {
    expect(() => intended({ renderedPrompt: "/tier-frontier\n\nImplement task 1.\n" })).toThrow(
      /divergence/u,
    );
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
  const complete = (status, extra = {}) =>
    reduceState(started(), {
      type: "child-completed",
      status,
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: at5,
      ...extra,
    });

  it("enters IMPLEMENT_RESULT before classification", () => {
    expect(complete("DONE").phase).toBe("IMPLEMENT_RESULT");
  });

  it("rejects an undefined status token", () => {
    expect(() => complete("DONE_ISH")).toThrow(/status/u);
  });

  it("advances DONE to review intent", () => {
    const result = complete("DONE");
    const next = reduceState(result, { type: "review-required", at: "2026-07-31T00:06:00.000Z" });
    expect(next.phase).toBe("REVIEW_DISPATCH_INTENT");
  });

  it("carries concern evidence for an observational DONE_WITH_CONCERNS", () => {
    const result = complete("DONE_WITH_CONCERNS", {
      concerns: [{ kind: "observational", note: "naming could be clearer" }],
    });
    expect(result.dispatch.concerns).toHaveLength(1);
    expect(
      reduceState(result, { type: "review-required", at: "2026-07-31T00:06:00.000Z" }).phase,
    ).toBe("REVIEW_DISPATCH_INTENT");
  });

  it("requires a ruling for a correctness or scope concern", () => {
    const result = complete("DONE_WITH_CONCERNS", {
      concerns: [{ kind: "correctness", note: "the retry bound may be off by one" }],
    });
    expect(() =>
      reduceState(result, { type: "review-required", at: "2026-07-31T00:06:00.000Z" }),
    ).toThrow(/ruling/u);
  });

  it("enters TASK_BLOCKED immediately on BLOCKED", () => {
    expect(complete("BLOCKED", { reason: "the interface does not exist" }).phase).toBe(
      "IMPLEMENT_RESULT",
    );
    const blocked = reduceState(
      complete("BLOCKED", { reason: "the interface does not exist" }),
      { type: "task-blocked", reason: "the interface does not exist", at: "2026-07-31T00:06:00.000Z" },
    );
    expect(blocked.phase).toBe("TASK_BLOCKED");
  });
});

describe("bounded context retry", () => {
  const enrich = (state, n) =>
    reduceState(state, {
      type: "context-enrichment-required",
      reason: `needs context ${String(n)}`,
      at: `2026-07-31T00:0${String(5 + n)}:00.000Z`,
    });

  const needsContext = (state) =>
    reduceState(state, {
      type: "child-completed",
      status: "NEEDS_CONTEXT",
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: at5,
    });

  it("allows two enrichments at the planned tier without touching fixRound", () => {
    const first = enrich(needsContext(started()), 1);
    expect(first.phase).toBe("IMPLEMENT_DISPATCH_INTENT");
    expect(first.contextAttempts).toBe(1);
    expect(first.currentImplementerTier).toBe("economy");
    expect(first.fixRound).toBe(0);
  });

  it("blocks the third NEEDS_CONTEXT without incrementing fixRound", () => {
    let state = enrich(needsContext(started()), 1);
    state = reduceState(state, {
      type: "dispatch-started",
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f814",
      at: "2026-07-31T00:08:00.000Z",
    });
    state = reduceState(state, {
      type: "child-completed",
      status: "NEEDS_CONTEXT",
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: "2026-07-31T00:09:00.000Z",
    });
    state = reduceState(state, {
      type: "context-enrichment-required",
      reason: "needs context 2",
      at: "2026-07-31T00:10:00.000Z",
    });
    expect(state.contextAttempts).toBe(2);

    state = reduceState(state, {
      type: "dispatch-started",
      sessionId: "019fb673-4324-7c1d-98a2-3c638e29f815",
      at: "2026-07-31T00:11:00.000Z",
    });
    state = reduceState(state, {
      type: "child-completed",
      status: "NEEDS_CONTEXT",
      reportPath: `${RUN}/task-1-implementer-report.md`,
      at: "2026-07-31T00:12:00.000Z",
    });
    expect(() =>
      reduceState(state, {
        type: "context-enrichment-required",
        reason: "needs context 3",
        at: "2026-07-31T00:13:00.000Z",
      }),
    ).toThrow(/context/u);

    const blocked = reduceState(state, {
      type: "task-blocked",
      reason: "three context attempts exhausted",
      at: "2026-07-31T00:13:00.000Z",
    });
    expect(blocked.phase).toBe("TASK_BLOCKED");
    expect(blocked.fixRound).toBe(0);
  });
});
