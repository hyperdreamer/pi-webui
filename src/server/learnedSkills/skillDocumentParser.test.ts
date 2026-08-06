import { describe, expect, it } from "vitest";
import { parseLearnedSkillDocument } from "./skillDocumentParser.js";

const FULL_SKILL = {
  id: "verify-red",
  filePath: "/agent/pi-hermes-memory/skills/verify-red/SKILL.md",
  content: [
    "---",
    'name: "verify-red"',
    'description: "Prove RED."',
    "version: 2",
    'created: "2026-08-01"',
    'updated: "2026-08-05"',
    "---",
    "## Procedure",
    "Run it.",
  ].join("\n"),
};

function documentWithFrontmatter(body: string): string {
  return `---\n${body}---\n## Procedure\nRun it.`;
}

describe("parseLearnedSkillDocument", () => {
  it("parses a full hermes-shaped skill document", () => {
    expect(parseLearnedSkillDocument(FULL_SKILL)).toEqual({
      id: "verify-red",
      name: "verify-red",
      description: "Prove RED.",
      filePath: "/agent/pi-hermes-memory/skills/verify-red/SKILL.md",
      version: 2,
      created: "2026-08-01",
      updated: "2026-08-05",
    });
  });

  it("returns undefined when the document has no frontmatter", () => {
    expect(parseLearnedSkillDocument({
      id: "plain",
      filePath: "/skills/plain/SKILL.md",
      content: "## Procedure\nNothing structured here.",
    })).toBeUndefined();
  });

  it("returns undefined for malformed frontmatter", () => {
    expect(parseLearnedSkillDocument({
      id: "broken",
      filePath: "/skills/broken/SKILL.md",
      content: documentWithFrontmatter('name: [unclosed\ndescription: "Prove BROKEN."\n'),
    })).toBeUndefined();
  });

  it.each([
    ["a missing name", 'description: "Fine."\n'],
    ["a blank name", 'name: ""\ndescription: "Fine."\n'],
    ["a whitespace-only name", 'name: "   "\ndescription: "Fine."\n'],
    ["a non-string name", 'name: 123\ndescription: "Fine."\n'],
    ["a missing description", 'name: "fine"\n'],
    ["a blank description", 'name: "fine"\ndescription: ""\n'],
    ["a non-string description", 'name: "fine"\ndescription: false\n'],
  ])("returns undefined for %s", (_label, frontmatterBody) => {
    expect(parseLearnedSkillDocument({
      id: "bad",
      filePath: "/skills/bad/SKILL.md",
      content: documentWithFrontmatter(frontmatterBody),
    })).toBeUndefined();
  });

  it.each([
    ["version", 'name: "fine"\ndescription: "Fine."\nversion: "2"\n'],
    ["created", 'name: "fine"\ndescription: "Fine."\ncreated: 2\n'],
    ["created as null", 'name: "fine"\ndescription: "Fine."\ncreated:\n'],
    ["updated", 'name: "fine"\ndescription: "Fine."\nupdated: true\n'],
    ["updated as null", 'name: "fine"\ndescription: "Fine."\nupdated:\n'],
  ])("returns undefined when %s has the wrong type", (_label, frontmatterBody) => {
    expect(parseLearnedSkillDocument({
      id: "bad",
      filePath: "/skills/bad/SKILL.md",
      content: documentWithFrontmatter(frontmatterBody),
    })).toBeUndefined();
  });

  it("returns required fields when optional metadata is absent", () => {
    expect(parseLearnedSkillDocument({
      id: "minimal",
      filePath: "/skills/minimal/SKILL.md",
      content: documentWithFrontmatter('name: "minimal"\ndescription: "A minimal skill."\n'),
    })).toEqual({
      id: "minimal",
      name: "minimal",
      description: "A minimal skill.",
      filePath: "/skills/minimal/SKILL.md",
    });
  });

  it("trims required strings", () => {
    expect(parseLearnedSkillDocument({
      id: "padded",
      filePath: "/skills/padded/SKILL.md",
      content: documentWithFrontmatter('name: "  padded  "\ndescription: "  A padded skill.  "\n'),
    })).toEqual({
      id: "padded",
      name: "padded",
      description: "A padded skill.",
      filePath: "/skills/padded/SKILL.md",
    });
  });

  it("accepts unquoted plain-scalar dates as strings", () => {
    expect(parseLearnedSkillDocument({
      id: "plain-dates",
      filePath: "/skills/plain-dates/SKILL.md",
      content: documentWithFrontmatter('name: "plain-dates"\ndescription: "Plain dates."\ncreated: 2026-08-01\nupdated: 2026-08-05\n'),
    })).toMatchObject({
      created: "2026-08-01",
      updated: "2026-08-05",
    });
  });
});
