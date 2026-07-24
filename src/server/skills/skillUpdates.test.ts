import { describe, expect, it } from "vitest";
import type { SkillInstallInfo } from "../../shared/apiTypes.js";
import { buildSkillUpdateArgs, checkSkillUpdate, checkSkillUpdates, skillUpdateKey } from "./skillUpdates.js";

function install(overrides: Partial<SkillInstallInfo> = {}): SkillInstallInfo {
  return {
    package: "owner/repo@example-skill",
    scope: "global",
    source: "owner/repo",
    sourceType: "github",
    skillsShUrl: "https://skills.sh/owner/repo/example-skill",
    skillPath: "skills/example-skill/SKILL.md",
    versionHash: "current-hash",
    canCheckForUpdates: true,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("skill update checks", () => {
  it("compares global skill folders against the remote Git tree", async () => {
    const requestedUrls: string[] = [];
    const upToDate = await checkSkillUpdate(install(), {
      fetcher: (url) => {
        requestedUrls.push(url);
        return Promise.resolve(jsonResponse({ sha: "root-hash", tree: [{ type: "tree", path: "skills/example-skill", sha: "current-hash" }] }));
      },
    });
    const available = await checkSkillUpdate(install(), {
      fetcher: () => Promise.resolve(jsonResponse({ sha: "root-hash", tree: [{ type: "tree", path: "skills/example-skill", sha: "next-hash" }] })),
    });

    expect(upToDate).toMatchObject({ state: "up-to-date", latestVersion: "current-hash" });
    expect(available).toMatchObject({ state: "update-available", currentVersion: "current-hash", latestVersion: "next-hash" });
    expect(requestedUrls[0]).toContain("repos/owner/repo/git/trees/HEAD");
  });

  it("uses the repository tree for root skills and skills.sh snapshots for project skills", async () => {
    const rootResult = await checkSkillUpdate(install({ skillPath: "SKILL.md" }), {
      fetcher: () => Promise.resolve(jsonResponse({ sha: "next-root", tree: [] })),
    });
    let requestedUrl = "";
    const projectResult = await checkSkillUpdate(install({ scope: "project" }), {
      skillsApiBase: "https://skills.test",
      fetcher: (url) => {
        requestedUrl = url;
        return Promise.resolve(jsonResponse({ hash: "current-hash" }));
      },
    });

    expect(rootResult).toMatchObject({ state: "update-available", latestVersion: "next-root" });
    expect(projectResult).toMatchObject({ state: "up-to-date" });
    expect(requestedUrl).toBe("https://skills.test/api/download/owner/repo/example-skill");
  });

  it("reports unsupported and remote failures without throwing to the dialog", async () => {
    let called = false;
    const unsupported = await checkSkillUpdate(install({ canCheckForUpdates: false }), {
      fetcher: () => {
        called = true;
        return Promise.resolve(jsonResponse({}));
      },
    });
    const failed = await checkSkillUpdate(install(), { fetcher: () => Promise.resolve(jsonResponse({}, 503)) });

    expect(unsupported.state).toBe("unsupported");
    expect(called).toBe(false);
    expect(failed).toMatchObject({ state: "error", message: "HTTP 503" });
    expect(skillUpdateKey(install())).toBe("global\0owner/repo@example-skill");
  });

  it("falls back to Git after rate limiting and builds Pi-only update commands", async () => {
    let resolved = false;
    const result = await checkSkillUpdate(install(), {
      fetcher: () => Promise.resolve(jsonResponse({}, 403)),
      resolveGitTreeHash: () => {
        resolved = true;
        return Promise.resolve("next-hash");
      },
    });

    expect(resolved).toBe(true);
    expect(result).toMatchObject({ state: "update-available", latestVersion: "next-hash" });
    expect(buildSkillUpdateArgs(install())).toEqual([
      "skills", "add", "owner/repo/skills/example-skill", "--skill", "example-skill", "-y", "--agent", "pi", "-g",
    ]);
    expect(buildSkillUpdateArgs(install({ scope: "project", ref: "release/v2" }))).toEqual([
      "skills", "add", "owner/repo/skills/example-skill#release%2Fv2", "--skill", "example-skill", "-y", "--agent", "pi",
    ]);
  });

  it("coalesces identical remote reads while retaining a result for every skill", async () => {
    let requests = 0;
    const results = await checkSkillUpdates([
      install(),
      install({ package: "owner/repo@another-skill", skillPath: "skills/another-skill/SKILL.md", versionHash: "another-hash" }),
    ], {
      fetcher: () => {
        requests += 1;
        return Promise.resolve(jsonResponse({
          sha: "root-hash",
          tree: [
            { type: "tree", path: "skills/example-skill", sha: "current-hash" },
            { type: "tree", path: "skills/another-skill", sha: "another-hash" },
          ],
        }));
      },
    });

    expect(requests).toBe(1);
    expect(results.map((result) => result.state)).toEqual(["up-to-date", "up-to-date"]);
  });
});
