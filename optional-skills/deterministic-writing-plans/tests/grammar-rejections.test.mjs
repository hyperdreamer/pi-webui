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

  it("does not see a tier field that sits inside a code fence", () => {
    const fenced = VALID.replace(
      "**Implementer tier:** Fast",
      "```\n**Implementer tier:** Fast\n```"
    );
    expect(() => parse(fenced)).toThrow(/Task 1 has no Implementer tier/u);
  });
});
