// Pins the shipped template against the controller's real parser. If the grammar
// in plan-policy.mjs ever tightens, this fails instead of an author's plan.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePlanText } from "../../deterministic-subagent-driven-development/scripts/lib/plan-policy.mjs";

const SKELETON = fileURLToPath(
  new URL("../templates/plan-skeleton.md", import.meta.url)
);
const skeletonText = () => readFileSync(SKELETON, "utf8");

describe("shipped plan skeleton", () => {
  it("parses under the controller's grammar", () => {
    const plan = parsePlanText(skeletonText(), SKELETON);
    expect(plan.tasks.map((t) => [t.number, t.implementerTier])).toEqual([
      [1, "standard"],
      [2, "advanced"],
    ]);
  });

  it("carries a Global Constraints section, since it reaches every brief", () => {
    const plan = parsePlanText(skeletonText(), SKELETON);
    expect(plan.globalConstraints).toContain("Node 22.19");
  });

  it("leaks no horizontal rule into constraints or task bodies", () => {
    // The parser absorbs a trailing `---` into whatever section precedes it,
    // and that text is injected verbatim into every child brief.
    const plan = parsePlanText(skeletonText(), SKELETON);
    expect(plan.globalConstraints).not.toMatch(/^-{3,}$/mu);
    for (const task of plan.tasks) expect(task.body).not.toMatch(/^-{3,}$/mu);
  });

  it("declares an Interfaces block for every task", () => {
    const plan = parsePlanText(skeletonText(), SKELETON);
    for (const task of plan.tasks)
      expect(task.body).toContain("**Interfaces:**");
  });

  it("ends every task with a commit step", () => {
    const plan = parsePlanText(skeletonText(), SKELETON);
    for (const task of plan.tasks)
      expect(task.body).toMatch(/\*\*Step \d+: Commit\*\*/u);
  });
});
