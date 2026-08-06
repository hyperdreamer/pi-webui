import { describe, expect, it } from "vitest";
import type { LearnedSkill } from "../../shared/apiTypes.js";
import { LearnedSkillCatalog } from "./learnedSkillCatalog.js";
import type { LearnedSkillProviderResult } from "./learnedSkillProvider.js";

function resolved(result: LearnedSkillProviderResult): Promise<LearnedSkillProviderResult> {
  return Promise.resolve(result);
}

function skill(id: string, name: string, updated?: string, created?: string): LearnedSkill {
  return {
    id,
    name,
    description: `${name} description`,
    filePath: `/skills/${id}/SKILL.md`,
    ...(updated !== undefined ? { updated } : {}),
    ...(created !== undefined ? { created } : {}),
  };
}

describe("LearnedSkillCatalog", () => {
  it("returns unavailable when no providers are registered", async () => {
    const catalog = new LearnedSkillCatalog([]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({ kind: "unavailable" });
  });

  it("returns unavailable only when every provider reports unavailable", async () => {
    const catalog = new LearnedSkillCatalog([{ id: "one", read: () => resolved({ kind: "unavailable" }) }]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({ kind: "unavailable" });
  });

  it("treats a single available provider as sufficient", async () => {
    const catalog = new LearnedSkillCatalog([
      { id: "unavailable", read: () => resolved({ kind: "unavailable" }) },
      { id: "one", read: () => resolved({ kind: "data", globalSkills: [skill("a", "alpha")], projectSkills: [] }) },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [{ ...skill("a", "alpha"), id: "one:a" }],
      projectSkills: [],
    });
  });

  it("prefixes provider-local ids while aggregating scopes", async () => {
    const catalog = new LearnedSkillCatalog([
      { id: "one", read: () => resolved({ kind: "data", globalSkills: [skill("a", "alpha")], projectSkills: [] }) },
      { id: "two", read: () => resolved({ kind: "data", globalSkills: [], projectSkills: [skill("a", "alpha")] }) },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [{ ...skill("a", "alpha"), id: "one:a" }],
      projectSkills: [{ ...skill("a", "alpha"), id: "two:a" }],
    });
  });

  it("retains the first available provider's project-unavailable message", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalSkills: [],
          projectSkills: [],
          projectUnavailableMessage: "First project failure",
        }),
      },
      {
        id: "two",
        read: () => resolved({
          kind: "data",
          globalSkills: [],
          projectSkills: [],
          projectUnavailableMessage: "Second project failure",
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [],
      projectSkills: [],
      projectUnavailableMessage: "First project failure",
    });
  });

  it("retains successful project entries alongside another provider's project warning", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "unavailable-project",
        read: () => resolved({
          kind: "data",
          globalSkills: [],
          projectSkills: [],
          projectUnavailableMessage: "One provider could not read project skills.",
        }),
      },
      {
        id: "project-data",
        read: () => resolved({
          kind: "data",
          globalSkills: [],
          projectSkills: [skill("entry", "entry")],
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [],
      projectSkills: [{ ...skill("entry", "entry"), id: "project-data:entry" }],
      projectUnavailableMessage: "One provider could not read project skills.",
    });
  });

  it("sorts global and project skills independently by updated descending", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalSkills: [skill("old", "old", "2026-08-01"), skill("new", "new", "2026-08-05"), skill("mid", "mid", "2026-08-03")],
          projectSkills: [skill("p-old", "p-old", "2026-07-01"), skill("p-new", "p-new", "2026-08-05")],
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [
        { ...skill("new", "new", "2026-08-05"), id: "one:new" },
        { ...skill("mid", "mid", "2026-08-03"), id: "one:mid" },
        { ...skill("old", "old", "2026-08-01"), id: "one:old" },
      ],
      projectSkills: [
        { ...skill("p-new", "p-new", "2026-08-05"), id: "one:p-new" },
        { ...skill("p-old", "p-old", "2026-07-01"), id: "one:p-old" },
      ],
    });
  });

  it("breaks updated ties by created descending", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalSkills: [
            skill("older", "older", "2026-08-05", "2026-07-01"),
            skill("newer", "newer", "2026-08-05", "2026-07-10"),
          ],
          projectSkills: [],
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [
        { ...skill("newer", "newer", "2026-08-05", "2026-07-10"), id: "one:newer" },
        { ...skill("older", "older", "2026-08-05", "2026-07-01"), id: "one:older" },
      ],
      projectSkills: [],
    });
  });

  it("breaks created ties by name ascending", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalSkills: [
            skill("c", "charlie", "2026-08-05", "2026-07-01"),
            skill("a", "alpha", "2026-08-05", "2026-07-01"),
            skill("b", "bravo", "2026-08-05", "2026-07-01"),
          ],
          projectSkills: [],
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [
        { ...skill("a", "alpha", "2026-08-05", "2026-07-01"), id: "one:a" },
        { ...skill("b", "bravo", "2026-08-05", "2026-07-01"), id: "one:b" },
        { ...skill("c", "charlie", "2026-08-05", "2026-07-01"), id: "one:c" },
      ],
      projectSkills: [],
    });
  });

  it("sorts skills without updated or created after dated skills", async () => {
    const catalog = new LearnedSkillCatalog([
      {
        id: "one",
        read: () => resolved({
          kind: "data",
          globalSkills: [
            skill("undated", "undated"),
            skill("created-only", "created-only", undefined, "2026-07-01"),
            skill("updated-only", "updated-only", "2026-08-01"),
          ],
          projectSkills: [],
        }),
      },
    ]);

    await expect(catalog.read("/work/repo")).resolves.toEqual({
      kind: "data",
      globalSkills: [
        { ...skill("updated-only", "updated-only", "2026-08-01"), id: "one:updated-only" },
        { ...skill("created-only", "created-only", undefined, "2026-07-01"), id: "one:created-only" },
        { ...skill("undated", "undated"), id: "one:undated" },
      ],
      projectSkills: [],
    });
  });
});
