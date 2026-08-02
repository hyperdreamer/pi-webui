// The mistakes a plan author actually makes. Each asserts the parser rejects,
// so the skill's guidance stays anchored to real behavior rather than belief.
import { describe, expect, it } from "vitest";
import { parsePlanText } from "../../subagent-driven-development/scripts/lib/plan-policy.mjs";

const VALID = [
  "# P",
  "",
  "## Task 1: Only task",
  "",
  "**Implementer tier:** Fast",
  "",
  "- [ ] **Step 1: Do it**",
  "",
].join("\n");

const parse = (text) => parsePlanText(text, "<test>");

describe("grammar acceptance", () => {
  it("accepts the minimal valid shape and lowercases the tier", () => {
    expect(parse(VALID).tasks).toEqual([
      expect.objectContaining({
        number: 1,
        title: "Only task",
        implementerTier: "fast",
      }),
    ]);
  });
});

describe("silent truncation traps", () => {
  // These do not throw. They discard content, which is worse: the plan validates
  // and the implementer never receives the missing steps.
  it("drops every line after a plain ## heading inside a task body", () => {
    const withH2 = [
      "# P",
      "",
      "## Task 1: T",
      "",
      "**Implementer tier:** Fast",
      "",
      "- [ ] **Step 1: first**",
      "",
      "## Notes",
      "",
      "- [ ] **Step 2: vanishes**",
      "",
      "- [ ] **Step 3: Commit**",
      "",
    ].join("\n");
    const [task] = parse(withH2).tasks;
    expect(task.body).not.toContain("vanishes");
    expect(task.body).not.toContain("Step 3");
    expect(task.body).toBe("- [ ] **Step 1: first**");
  });

  it("keeps content after a ### heading, which is the safe form", () => {
    const withH3 = [
      "# P",
      "",
      "## Task 1: T",
      "",
      "**Implementer tier:** Fast",
      "",
      "- [ ] **Step 1: first**",
      "",
      "### Notes",
      "",
      "- [ ] **Step 2: survives**",
      "",
    ].join("\n");
    expect(parse(withH3).tasks[0].body).toContain("survives");
  });

  it("absorbs a trailing horizontal rule into the preceding section", () => {
    const withRule = `${VALID}\n---\n`;
    expect(parse(withRule).tasks[0].body).toMatch(/^-{3,}$/mu);
  });
});

describe("grammar rejections", () => {
  it("rejects a non-canonical heading depth", () => {
    expect(() => parse(VALID.replace("## Task 1:", "### Task 1:"))).toThrow(
      /task-like heading is not canonical/u
    );
  });

  it("rejects a lowercase tier value in the document", () => {
    expect(() => parse(VALID.replace("Fast", "fast"))).toThrow(
      /malformed Implementer tier field/u
    );
  });

  it("rejects a trailing space after the tier value", () => {
    expect(() => parse(VALID.replace("tier:** Fast", "tier:** Fast "))).toThrow(
      /malformed Implementer tier field/u
    );
  });

  it("rejects a missing tier field", () => {
    expect(() =>
      parse(VALID.replace("**Implementer tier:** Fast\n", ""))
    ).toThrow(/Task 1 has no Implementer tier/u);
  });

  it("rejects a gap in task numbering", () => {
    const gapped = `${VALID}\n## Task 3: Skipped two\n\n**Implementer tier:** Fast\n`;
    expect(() => parse(gapped)).toThrow(/expected Task 2 but found Task 3/u);
  });

  it("rejects a duplicate Global Constraints section", () => {
    const dup = `# P\n\n## Global Constraints\n\n- a\n\n## Global Constraints\n\n- b\n\n${VALID.slice(
      VALID.indexOf("## Task 1:")
    )}`;
    expect(() => parse(dup)).toThrow(/duplicate Global Constraints section/u);
  });

  it("rejects Global Constraints placed after the first task", () => {
    const late = `${VALID}\n## Global Constraints\n\n- a\n`;
    expect(() => parse(late)).toThrow(
      /Global Constraints must precede the first task/u
    );
  });

  it("does not see a tier field that sits inside a code fence", () => {
    const fenced = VALID.replace(
      "**Implementer tier:** Fast",
      "```\n**Implementer tier:** Fast\n```"
    );
    expect(() => parse(fenced)).toThrow(/Task 1 has no Implementer tier/u);
  });
});
