import { THINKING_LEVEL_ORDER } from "./modelPolicyLabels";

export interface ThinkingLevelOption {
  level: string;
  supported: boolean;
  selected: boolean;
  description?: string;
}

const DESCRIPTIONS: Record<string, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Maximum reasoning (~32k tokens)",
};

export function thinkingLevelOptions(input: {
  supported: readonly string[];
  all: readonly string[];
  selected: string;
}): ThinkingLevelOption[] {
  const supported = new Set(input.supported);
  const seen = new Set<string>();
  const levels: string[] = [];
  for (const level of [...input.supported, ...input.all]) {
    if (seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }

  const rank = (level: string): number => {
    const index = THINKING_LEVEL_ORDER.findIndex((candidate) => candidate === level);
    return index === -1 ? THINKING_LEVEL_ORDER.length : index;
  };

  return levels
    .map((level, index) => ({ level, index }))
    .sort((left, right) => {
      const byRank = rank(left.level) - rank(right.level);
      return byRank === 0 ? left.index - right.index : byRank;
    })
    .map(({ level }) => ({
      level,
      supported: supported.has(level),
      selected: level === input.selected,
      ...(DESCRIPTIONS[level] === undefined ? {} : { description: DESCRIPTIONS[level] }),
    }));
}
