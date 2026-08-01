import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fixerTier,
  parsePlanText,
  reReviewerTier,
  reviewerTier,
  roleTier,
  tierDirective,
  tierLabel,
  TIERS,
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
