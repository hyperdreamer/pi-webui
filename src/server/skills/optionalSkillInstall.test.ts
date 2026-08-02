import { describe, expect, it } from "vitest";
import {
  OPTIONAL_SKILLS,
  pruneSkillLock,
  rewriteSkillNames,
  stripSkillPrefix,
} from "./optionalSkillInstall";

describe("rewriteSkillNames", () => {
  it("rewrites a frontmatter name to the installed name", () => {
    expect(rewriteSkillNames("name: deterministic-writing-plans")).toBe(
      "name: writing-plans"
    );
  });

  it("rewrites the sibling directory path the authoring skill depends on", () => {
    const before =
      "`../deterministic-subagent-driven-development/references/plan-contract.md`";
    expect(rewriteSkillNames(before)).toBe(
      "`../subagent-driven-development/references/plan-contract.md`"
    );
  });

  it("rewrites every occurrence, not just the first", () => {
    const before =
      "deterministic-writing-plans and deterministic-writing-plans again";
    expect(rewriteSkillNames(before)).toBe(
      "writing-plans and writing-plans again"
    );
  });

  it("rewrites the hashed SKILL_NAME constant", () => {
    const before =
      'export const SKILL_NAME = "deterministic-subagent-driven-development";';
    expect(rewriteSkillNames(before)).toBe(
      'export const SKILL_NAME = "subagent-driven-development";'
    );
  });

  it("leaves content without prefixed names unchanged", () => {
    const before = "The deterministic controller parses the plan.";
    expect(rewriteSkillNames(before)).toBe(before);
  });

  it("does not corrupt prose that already uses the unprefixed name", () => {
    // Guards the doubling bug a naive blanket rename produced: rewriting the
    // short name first would turn "subagent-driven-development" into
    // "deterministic-subagent-driven-development" on a later pass.
    const before = "the deterministic subagent-driven-development controller";
    expect(rewriteSkillNames(before)).toBe(before);
  });
});

describe("stripSkillPrefix", () => {
  it("strips the prefix when present", () => {
    expect(stripSkillPrefix("deterministic-writing-plans")).toBe(
      "writing-plans"
    );
  });

  it("leaves an unprefixed name alone", () => {
    expect(stripSkillPrefix("brainstorming")).toBe("brainstorming");
  });

  it("agrees with the configured install names", () => {
    for (const skill of OPTIONAL_SKILLS) {
      expect(stripSkillPrefix(skill.sourceName)).toBe(skill.installName);
    }
  });
});

describe("pruneSkillLock", () => {
  const lock = {
    version: 1,
    skills: {
      "writing-plans": { source: "jnmetacode/superpowers-zh" },
      "subagent-driven-development": { source: "obra/superpowers" },
      brainstorming: { source: "obra/superpowers" },
    },
    dismissed: {},
  };

  it("removes entries for the skills this installer owns", () => {
    const result = pruneSkillLock(lock);
    expect(Object.keys(result.document.skills ?? {})).toEqual([
      "brainstorming",
    ]);
    expect([...result.removed].sort()).toEqual([
      "subagent-driven-development",
      "writing-plans",
    ]);
  });

  it("preserves unrelated entries and sibling top-level keys", () => {
    const result = pruneSkillLock(lock);
    expect(result.document.skills?.["brainstorming"]).toEqual({
      source: "obra/superpowers",
    });
    expect(result.document["version"]).toBe(1);
    expect(result.document["dismissed"]).toEqual({});
  });

  it("does not mutate the input document", () => {
    pruneSkillLock(lock);
    expect(Object.keys(lock.skills)).toHaveLength(3);
  });

  it("reports nothing removed when no owned entry is present", () => {
    const clean = { version: 1, skills: { brainstorming: {} } };
    const result = pruneSkillLock(clean);
    expect(result.removed).toEqual([]);
    expect(result.document).toBe(clean);
  });

  it("tolerates a lock document with no skills map", () => {
    const empty = { version: 1 };
    const result = pruneSkillLock(empty);
    expect(result.removed).toEqual([]);
    expect(result.document).toBe(empty);
  });
});
