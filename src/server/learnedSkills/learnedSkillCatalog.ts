import type { LearnedSkill, LearnedSkillsSnapshotResponse } from "../../shared/apiTypes.js";
import type { LearnedSkillProvider } from "./learnedSkillProvider.js";

export class LearnedSkillCatalog {
  constructor(private readonly providers: readonly LearnedSkillProvider[]) {}

  async read(projectPath: string): Promise<LearnedSkillsSnapshotResponse> {
    const results = await Promise.all(
      this.providers.map(async (provider) => ({ provider, result: await provider.read({ projectPath }) })),
    );
    const globalSkills: LearnedSkill[] = [];
    const projectSkills: LearnedSkill[] = [];
    let projectUnavailableMessage: string | undefined;
    let hasAvailableProvider = false;

    for (const { provider, result } of results) {
      if (result.kind === "unavailable") continue;

      hasAvailableProvider = true;
      globalSkills.push(...namespaceSkills(provider.id, result.globalSkills));
      projectSkills.push(...namespaceSkills(provider.id, result.projectSkills));
      if (projectUnavailableMessage === undefined && result.projectUnavailableMessage !== undefined) {
        projectUnavailableMessage = result.projectUnavailableMessage;
      }
    }

    if (!hasAvailableProvider) return { kind: "unavailable" };

    globalSkills.sort(compareLearnedSkills);
    projectSkills.sort(compareLearnedSkills);

    return {
      kind: "data",
      globalSkills,
      projectSkills,
      ...(projectUnavailableMessage === undefined ? {} : { projectUnavailableMessage }),
    };
  }
}

function namespaceSkills(providerId: string, skills: LearnedSkill[]): LearnedSkill[] {
  return skills.map((skill) => ({ ...skill, id: `${providerId}:${skill.id}` }));
}

/**
 * Matches hermes's own `loadIndex` ordering: `updated` descending, then
 * `created` descending, then name. Skills without either date sort last.
 */
function compareLearnedSkills(a: LearnedSkill, b: LearnedSkill): number {
  const aUndated = a.updated === undefined && a.created === undefined;
  const bUndated = b.updated === undefined && b.created === undefined;
  if (aUndated !== bUndated) return aUndated ? 1 : -1;

  const byUpdated = compareDescending(a.updated, b.updated);
  if (byUpdated !== 0) return byUpdated;

  const byCreated = compareDescending(a.created, b.created);
  if (byCreated !== 0) return byCreated;

  return a.name.localeCompare(b.name);
}

function compareDescending(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}
