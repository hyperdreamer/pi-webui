export interface LearnedSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  version?: number;
  created?: string;
  updated?: string;
}

export type LearnedSkillsWorkspaceState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      globalSkills: LearnedSkill[];
      projectSkills: LearnedSkill[];
      projectUnavailableMessage?: string;
      refreshError?: string;
    }
  | { kind: "error"; message: string };
