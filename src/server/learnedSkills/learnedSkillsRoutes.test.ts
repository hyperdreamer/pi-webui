import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLearnedSkillsRoutes } from "./learnedSkillsRoutes.js";
import type { ActiveAgentProfileProvider } from "../activeAgentProfileProvider.js";
import type { SessionDaemonAgentProfileResult } from "../../sessiond/sessionDaemonClient.js";

const VALID_SKILL = [
  "---",
  'name: "global-skill"',
  'description: "Global skill"',
  "version: 2",
  'created: "2026-08-01"',
  'updated: "2026-08-05"',
  "---",
  "## Procedure",
  "Run it.",
].join("\n");

function fakeProfileProvider(dir: string): ActiveAgentProfileProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    getActiveAgentProfile: async (): Promise<SessionDaemonAgentProfileResult> => ({
      status: "available",
      profile: {
        schemaVersion: 1 as const,
        revision: "test-revision",
        command: "pi",
        dir,
        sessionDirEnvKeys: [],
      },
    }),
  };
}

function unavailableProvider(): ActiveAgentProfileProvider {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    getActiveAgentProfile: async (): Promise<SessionDaemonAgentProfileResult> => ({
      status: "unavailable",
      error: "no agent profile",
    }),
  };
}

describe("learnedSkillsRoutes", () => {
  let app: FastifyInstance;
  let agentDir: string;
  let provider: ActiveAgentProfileProvider;

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "pi-webui-learned-skills-routes-"));
    provider = fakeProfileProvider(agentDir);
  });

  afterEach(async () => {
    await app.close();
    await rm(agentDir, { recursive: true, force: true });
  });

  async function writeSkillFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(agentDir, relativePath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    registerLearnedSkillsRoutes(instance, provider, "/api");
    registerLearnedSkillsRoutes(instance, provider, "/api/machines/local");
    return instance;
  }

  describe("GET /api/agent-skills/snapshot", () => {
    it("returns 400 when projectPath query is missing", async () => {
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-skills/snapshot" });
      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when projectPath query is empty", async () => {
      app = await buildApp();
      const response = await app.inject({ method: "GET", url: "/api/agent-skills/snapshot?projectPath=" });
      expect(response.statusCode).toBe(400);
    });

    it("returns unavailable when no provider roots exist", async () => {
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-skills/snapshot?projectPath=%2Fwork%2Frepo",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ kind: "unavailable" });
    });

    it("returns global and project skills in one snapshot", async () => {
      await writeSkillFile("pi-hermes-memory/skills/global-skill/SKILL.md", VALID_SKILL);
      await writeSkillFile(
        "projects-memory/repo/skills/project-skill/SKILL.md",
        `---\nname: "project-skill"\ndescription: "Project scoped."\n---\n## Procedure\nRun it.`,
      );
      app = await buildApp();

      const response = await app.inject({
        method: "GET",
        url: "/api/agent-skills/snapshot?projectPath=%2Fwork%2Frepo",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        kind: "data",
        globalSkills: [{
          id: "pi-hermes-memory:global-skill",
          name: "global-skill",
          description: "Global skill",
          filePath: join(agentDir, "pi-hermes-memory", "skills", "global-skill", "SKILL.md"),
          version: 2,
          created: "2026-08-01",
          updated: "2026-08-05",
        }],
        projectSkills: [{
          id: "pi-hermes-memory:project-skill",
          name: "project-skill",
          description: "Project scoped.",
          filePath: join(agentDir, "projects-memory", "repo", "skills", "project-skill", "SKILL.md"),
        }],
      });
    });

    it("registers the snapshot under the local machine prefix", async () => {
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/machines/local/agent-skills/snapshot?projectPath=%2Fwork%2Frepo",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind: "unavailable" });
    });

    it("returns 503 when agent profile is unavailable", async () => {
      provider = unavailableProvider();
      app = await buildApp();
      const response = await app.inject({
        method: "GET",
        url: "/api/agent-skills/snapshot?projectPath=%2Fwork%2Frepo",
      });
      expect(response.statusCode).toBe(503);
    });
  });
});
