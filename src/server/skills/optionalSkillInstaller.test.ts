import { beforeEach, describe, expect, it } from "vitest";
import { installOptionalSkills } from "./optionalSkillInstaller";
import type { InstallerIo, InstallRequest } from "./optionalSkillInstaller";

/** In-memory filesystem recording every operation the installer performs. */
function createFakeIo(files: Record<string, string>) {
  const tree = new Map(Object.entries(files));
  const dirs = new Set<string>();
  const manifestsRegenerated: string[] = [];
  const moves: [string, string][] = [];

  const io: InstallerIo = {
    exists: (path) =>
      tree.has(path) || [...tree.keys()].some((k) => k.startsWith(`${path}/`)),
    listFiles: (dir) =>
      [...tree.keys()]
        .filter((k) => k.startsWith(`${dir}/`))
        .map((k) => k.slice(dir.length + 1)),
    readFile: (path) => {
      const value = tree.get(path);
      if (value === undefined) throw new Error(`no such file: ${path}`);
      return value;
    },
    writeFile: (path, content) => void tree.set(path, content),
    copyFile: (from, to) => void tree.set(to, tree.get(from) ?? ""),
    makeDir: (path) => void dirs.add(path),
    movePath: (from, to) => {
      moves.push([from, to]);
      for (const key of [...tree.keys()].filter(
        (k) => k === from || k.startsWith(`${from}/`)
      )) {
        tree.set(key.replace(from, to), tree.get(key) ?? "");
        tree.delete(key);
      }
    },
    removePath: (path) => void tree.delete(path),
    regenerateManifest: (dir) => void manifestsRegenerated.push(dir),
  };

  return { io, tree, dirs, manifestsRegenerated, moves };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SKILLS = [
  { sourceName: "deterministic-writing-plans", installName: "writing-plans" },
];

function baseRequest(overrides: Partial<InstallRequest> = {}): InstallRequest {
  return {
    sourceRoot: "/pkg/optional-skills",
    skillsRoot: "/home/skills",
    backupRoot: "/home/backup-1",
    lockPath: "/home/.skill-lock.json",
    skills: SKILLS,
    ...overrides,
  };
}

describe("installOptionalSkills", () => {
  let fake: ReturnType<typeof createFakeIo>;

  beforeEach(() => {
    fake = createFakeIo({
      "/pkg/optional-skills/deterministic-writing-plans/SKILL.md":
        "name: deterministic-writing-plans\nsee ../deterministic-subagent-driven-development/x.md",
      "/home/skills/writing-plans/SKILL.md":
        "name: writing-plans\nupstream copy",
      "/home/.skill-lock.json": JSON.stringify({
        version: 1,
        skills: {
          "writing-plans": { source: "jnmetacode/superpowers-zh" },
          brainstorming: {},
        },
      }),
    });
  });

  it("rewrites the prefixed name in installed content", () => {
    installOptionalSkills(fake.io, baseRequest());
    expect(fake.tree.get("/home/skills/writing-plans/SKILL.md")).toContain(
      "name: writing-plans"
    );
  });

  it("rewrites sibling references to other optional skills", () => {
    installOptionalSkills(fake.io, baseRequest());
    const installed =
      fake.tree.get("/home/skills/writing-plans/SKILL.md") ?? "";
    expect(installed).toContain("../subagent-driven-development/x.md");
    expect(installed).not.toContain(
      "deterministic-subagent-driven-development"
    );
  });

  it("moves the existing skill into the backup before writing the new one", () => {
    installOptionalSkills(fake.io, baseRequest());
    expect(fake.moves).toEqual([
      ["/home/skills/writing-plans", "/home/backup-1/writing-plans"],
    ]);
    expect(fake.tree.get("/home/backup-1/writing-plans/SKILL.md")).toBe(
      "name: writing-plans\nupstream copy"
    );
  });

  it("backs up the lock file and removes only the owned entry", () => {
    const report = installOptionalSkills(fake.io, baseRequest());
    expect(report.lockEntriesRemoved).toEqual(["writing-plans"]);
    expect(fake.tree.has("/home/backup-1/skill-lock.json")).toBe(true);
    const lock: unknown = JSON.parse(
      fake.tree.get("/home/.skill-lock.json") ?? "{}"
    );
    const entries =
      isRecord(lock) && isRecord(lock["skills"]) ? lock["skills"] : {};
    expect(Object.keys(entries)).toEqual(["brainstorming"]);
  });

  it("regenerates the manifest after rewriting, not before", () => {
    installOptionalSkills(fake.io, baseRequest());
    expect(fake.manifestsRegenerated).toEqual(["/home/skills/writing-plans"]);
  });

  it("reports what it installed and backed up", () => {
    const report = installOptionalSkills(fake.io, baseRequest());
    expect(report.installed).toEqual(["writing-plans"]);
    expect(report.backedUp).toEqual(["writing-plans", "skill-lock.json"]);
    expect(report.backupRoot).toBe("/home/backup-1");
    expect(report.dryRun).toBe(false);
  });

  it("fails loudly when the build ships no optional skills", () => {
    const empty = createFakeIo({});
    expect(() => installOptionalSkills(empty.io, baseRequest())).toThrow(
      /does not ship optional skills/u
    );
  });

  it("rejects a corrupt lock file instead of overwriting it", () => {
    fake.tree.set("/home/.skill-lock.json", "{ not json");
    expect(() => installOptionalSkills(fake.io, baseRequest())).toThrow(
      /not valid JSON/u
    );
  });
});

describe("installOptionalSkills in dry-run mode", () => {
  it("changes nothing but still reports the plan", () => {
    const fake = createFakeIo({
      "/pkg/optional-skills/deterministic-writing-plans/SKILL.md":
        "name: deterministic-writing-plans",
      "/home/skills/writing-plans/SKILL.md": "upstream",
      "/home/.skill-lock.json": JSON.stringify({
        skills: { "writing-plans": {} },
      }),
    });
    const report = installOptionalSkills(
      fake.io,
      baseRequest({ dryRun: true })
    );

    expect(report.dryRun).toBe(true);
    expect(report.installed).toEqual(["writing-plans"]);
    expect(report.lockEntriesRemoved).toEqual(["writing-plans"]);
    expect(fake.moves).toEqual([]);
    expect(fake.manifestsRegenerated).toEqual([]);
    expect(fake.tree.get("/home/skills/writing-plans/SKILL.md")).toBe(
      "upstream"
    );
    expect(fake.tree.get("/home/.skill-lock.json")).toBe(
      JSON.stringify({ skills: { "writing-plans": {} } })
    );
  });
});
