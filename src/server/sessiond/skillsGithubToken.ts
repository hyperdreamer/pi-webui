interface GitHubTokenEnvironment {
  GITHUB_TOKEN?: string | undefined;
  GH_TOKEN?: string | undefined;
}

export function resolveSkillsGitHubToken(environment: GitHubTokenEnvironment): string | undefined {
  const githubToken = environment.GITHUB_TOKEN;
  if (githubToken !== undefined && githubToken !== "") return githubToken;
  return environment.GH_TOKEN;
}
