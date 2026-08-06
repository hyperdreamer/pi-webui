import type { LearnedSkillsSnapshotResponse } from "../../shared/apiTypes.js";

export interface LearnedSkillProviderInput {
  readonly projectPath?: string;
}

export type LearnedSkillProviderResult = LearnedSkillsSnapshotResponse;

export interface LearnedSkillProvider {
  readonly id: string;
  read(input: LearnedSkillProviderInput): Promise<LearnedSkillProviderResult>;
}
